import OpenAI from "openai";
import { config as appConfig } from "./config";
import { checkHtml, extractHtml } from "./html";
import { checkScripts } from "./syntax";
import { mockHtml, mockPlan } from "./mock";
import type { AgentEvent } from "./types";

/**
 * The agent team behind every generation:
 *   planner  (Emma, 产品经理) -> turns the request into a short build plan
 *   engineer (Alex, 工程师)   -> writes / rewrites the single-file app
 *   reviewer (Bob, 评审)      -> reads the code against the request; blocking findings go back
 *                                to the engineer for one fix pass
 *   qa       (质检)           -> rule-based structural check of the final document
 *
 * Any OpenAI-compatible endpoint works (configured for Tencent Cloud TokenHub by default).
 */

const PLANNER_SYSTEM = `你是 Atoms 团队里的产品经理 Emma。用户会描述想要的网页应用，或对已有应用提出修改意见。
请输出一份给工程师看的简短构建计划，纯文本，不要使用 Markdown 标题或代码块：
- 如果是新应用，第一行必须是「标题：<不超过 12 个字的应用名>」。
- 然后用一句话说明目标，再用 3-6 条以「- 」开头的要点列出核心功能与交互。
- 如果是修改已有应用，只列出这次要改动的要点，不要写标题行。
- 只描述功能与交互，不要指定技术栈或框架（工程师会用原生 HTML/CSS/JS 实现单文件应用）。
- 全文不超过 160 字，不要写代码，不要寒暄。`;

const ENGINEER_SYSTEM = `你是 Atoms 团队里的前端工程师 Alex。根据需求与计划，产出一个可以直接运行的单文件网页应用。
硬性要求：
1. 只输出一个完整的 HTML 文档，以 <!DOCTYPE html> 开头、以 </html> 结尾；不要输出任何解释文字，不要用代码块包裹。
2. 所有 CSS 与 JavaScript 都内联在这个文件里，不依赖任何外部脚本、样式、字体或图片链接（图标用 emoji 或内联 SVG）。
3. 功能必须真实可用：按钮、表单、状态切换都要有实际逻辑；需要保存的数据用 localStorage 持久化，并预置少量示例数据。
4. 界面要现代、美观、有设计感，适配桌面与手机宽度，界面文案使用用户所用的语言。
5. JavaScript 必须没有语法错误，使用原生 API，不使用 alert/prompt 做主要交互。
6. 如果给出了现有代码，在其基础上完成修改，并输出修改后的完整文件，保留未被要求改动的功能。`;

const REVIEWER_SYSTEM = `你是 Atoms 团队里的代码评审 Bob。你会拿到用户需求、产品计划和工程师写的单文件网页应用代码。
只找会让应用“不能用”或“没做到需求”的问题：JavaScript 语法或运行时错误、点击后没有反应的按钮、需求里明确要求却缺失的功能、数据没有按要求保存。
不要提代码风格、命名、性能、可访问性或“可以更好”的建议。
严格按下面的格式输出，不要输出别的内容：
结论：通过
或
结论：需要修改
- <问题 1：哪里、什么现象>
- <问题 2>
最多列 4 条。拿不准是不是问题时，判定为通过。`;

type Chat = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Output ceilings published for the models on TokenHub (kimi-k3 1M, deepseek-v4 384k, kimi-k2.7 256k,
// glm-5.x / mimo 128k, hy4 64k), plus smaller rungs for anything else.
const OUTPUT_LADDER = [1_000_000, 384_000, 256_000, 128_000, 64_000, 32_000, 16_000, 8_000];
/** Largest max_tokens each model accepted so far (null = only provider defaults worked). */
const outputCeiling = new Map<string, number | null>();

/** A piece of the model's reasoning, as opposed to its answer. Shown live, never saved. */
export type Thought = { thinking: string };
type Piece = string | Thought;
const isThought = (piece: Piece): piece is Thought => typeof piece !== "string";
/** Reasoning passed on per model call; past this the model keeps going but the stream stays quiet. */
const MAX_THINKING_CHARS = 60_000;

async function* streamChat(
  client: OpenAI,
  model: string,
  messages: Chat[],
  signal: AbortSignal,
  state: { truncated: boolean } = { truncated: false },
): AsyncGenerator<Piece> {
  const { reasoningEffort, maxTokens, noThinking } = appConfig().llm;
  // A job is not cut off for taking long, only for going quiet: the watchdog below fires when
  // the model has sent nothing at all (neither output nor reasoning) for `idleMs`.
  const idleMs = appConfig().generation.idleMs;
  const watchdog = new AbortController();
  let stalled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
    }, idleMs);
  };
  const linked = AbortSignal.any([signal, watchdog.signal]);
  alive();
  try {
    // Per-model way of keeping hidden reasoning short (see config.llm.noThinking).
    const reasoning = noThinking.test(model) ? { thinking: { type: "disabled" } } : { reasoning_effort: reasoningEffort };
    // Low reasoning effort keeps time-to-first-code at a few seconds; measured on glm-5.1 it cut a
    // full generation from ~200s (mostly hidden reasoning) to ~20s.
    //
    // No artificial output cap: ask for the largest output the model accepts. Omitting max_tokens is
    // not an option because providers then apply a small default. Each model's own ceiling differs,
    // so walk down a ladder on a 400 and remember what worked; the last rung sends provider defaults.
    const ladder: (number | null)[] = maxTokens ? [maxTokens, null] : [...OUTPUT_LADDER, null];
    const known = outputCeiling.get(model);
    const rungs = known !== undefined ? [known] : ladder;
    let stream;
    for (let i = 0; ; i++) {
      const limit = rungs[i];
      try {
        stream = await client.chat.completions.create(
          // `thinking` is a provider extension that the SDK's types do not know about.
          {
            model,
            messages,
            stream: true,
            ...(limit ? { max_tokens: limit, ...reasoning } : {}),
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal: linked },
        );
        outputCeiling.set(model, limit);
        break;
      } catch (error) {
        if (!(error instanceof OpenAI.BadRequestError) || i === rungs.length - 1) throw error;
      }
    }
    // Reasoning arrives either in its own field or inline as <think>...</think>. Both are kept out
    // of the product output and passed on as thoughts, so a model that reasons for minutes before
    // its first word of output does not look dead.
    let pending = "";
    let thinking = false;
    let thought = "";
    let thoughtSent = 0;
    const takeThought = () => {
      const text = thought.slice(0, Math.max(0, MAX_THINKING_CHARS - thoughtSent));
      thought = "";
      thoughtSent += text.length;
      return text;
    };
    for await (const chunk of stream) {
      alive();
      const choice = chunk.choices[0];
      if (choice?.finish_reason === "length") state.truncated = true;
      // `reasoning_content` is a provider extension that the SDK's types do not know about.
      const delta = choice?.delta as { content?: string | null; reasoning_content?: string | null } | undefined;
      if (delta?.reasoning_content) {
        thought += delta.reasoning_content;
        // Reasoning comes a few characters at a time; pass it on in larger pieces.
        if (thought.length >= 80) {
          const text = takeThought();
          if (text) yield { thinking: text };
        }
      }
      if (!delta?.content) continue;
      pending += delta.content;
      let out = "";
      for (;;) {
        const tag = thinking ? "</think>" : "<think>";
        const at = pending.indexOf(tag);
        if (at === -1) {
          // Hold back a tail that could be the start of a tag split across chunks.
          let keep = 0;
          for (let n = Math.min(tag.length - 1, pending.length); n > 0; n--) {
            if (tag.startsWith(pending.slice(-n))) {
              keep = n;
              break;
            }
          }
          const text = pending.slice(0, pending.length - keep);
          if (thinking) thought += text;
          else out += text;
          pending = pending.slice(pending.length - keep);
          break;
        }
        if (thinking) thought += pending.slice(0, at);
        else out += pending.slice(0, at);
        pending = pending.slice(at + tag.length);
        thinking = !thinking;
      }
      if (thought && (out || thought.length >= 80)) {
        const text = takeThought();
        if (text) yield { thinking: text };
      }
      if (out) yield out;
    }
    // An aborted stream can simply end instead of throwing; what it produced is not a full answer.
    if (stalled) throw new Error("stalled");
    signal.throwIfAborted();
    const rest = takeThought();
    if (rest) yield { thinking: rest };
    if (!thinking && pending) yield pending;
  } catch (error) {
    if (stalled && !signal.aborted) {
      throw new ProviderError(`模型超过 ${Math.round(idleMs / 1000)} 秒没有任何输出，已停止等待。可以重试，或换一个模型。`);
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}

/** A failure on the model provider's side (as opposed to one the request itself caused). */
export class ProviderError extends Error {}

function describeError(error: unknown) {
  if (error instanceof OpenAI.AuthenticationError) return "模型服务鉴权失败，请检查 LLM_API_KEY。";
  if (error instanceof OpenAI.RateLimitError) return "模型服务限流或额度不足，请稍后再试。";
  if (error instanceof OpenAI.NotFoundError) return "模型不存在，请检查 LLM_MODEL 与 LLM_BASE_URL。";
  if (error instanceof OpenAI.APIConnectionError) return "无法连接模型服务，请检查网络与 LLM_BASE_URL。";
  // Provider error bodies can echo request details; show only the status to end users.
  if (error instanceof OpenAI.APIError) return `模型服务出错（${error.status ?? "未知"}），请稍后再试。`;
  return error instanceof Error ? error.message : "生成失败";
}

export type AgentInput = {
  prompt: string;
  /** Latest saved HTML when iterating on an existing app. */
  currentHtml: string | null;
  /** Earlier user requests in this project, oldest first. */
  history: string[];
  /** Engineer model chosen by the user; must already be validated against the allowlist. */
  model?: string;
  signal: AbortSignal;
};

export type Review = { passed: boolean; findings: string[]; fixed: boolean };
export type AgentResult = {
  plan: string;
  title: string | null;
  html: string;
  issues: string[];
  review: Review | null;
};

type PipelineEvent = Extract<AgentEvent, { type: "stage" | "plan" | "code" | "code_reset" | "review" | "thinking" }>;

function splitPlan(raw: string) {
  // Anchored to a single line with bounded classes, so odd model output cannot make it backtrack.
  const match = raw.slice(0, 400).match(/^[ \t]*标题[:：][ \t]*([^\n]{1,60})$/m);
  const title = match ? match[1].trim().slice(0, 24) : null;
  const plan = (match ? raw.replace(match[0], "") : raw).trim();
  return { title, plan };
}

export function parseReview(raw: string) {
  const findings = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-•*]\s+/.test(line))
    .map((line) => line.replace(/^[-•*]\s+/, ""))
    .slice(0, 4);
  const passed = !/结论[:：]\s*需要修改/.test(raw) || findings.length === 0;
  return { passed, findings: passed ? [] : findings };
}

const earlier = (history: string[]) => `此前的需求记录：\n${history.map((h) => `- ${h}`).join("\n")}`;

/**
 * What the planner is asked. A project can have earlier requests and still no app (the first
 * attempts failed or were stopped); a follow-up such as "继续" then only makes sense together
 * with those requests, so they are passed along instead of treating the message as a new idea.
 */
export function plannerRequest(prompt: string, history: string[], hasApp: boolean) {
  if (hasApp) return `${history.length ? `${earlier(history)}\n\n` : ""}这是对已有应用的修改请求：\n${prompt}`;
  if (!history.length) return `这是一个新应用的需求：\n${prompt}`;
  return `${earlier(history)}\n\n以上需求还没有生成出可用的应用。这是用户的新消息：\n${prompt}\n\n请把它们合在一起，规划一个新应用。如果新消息只是"继续""重试"这类话，就按此前的需求来规划。`;
}

/** The engineer's view of the request; earlier requests are added only while there is no app yet. */
function engineerRequest(prompt: string, history: string[], hasApp: boolean) {
  return !hasApp && history.length ? `${earlier(history)}\n\n用户的新消息：\n${prompt}` : `用户需求：\n${prompt}`;
}

const MAX_NOTE_CHARS = 8_000;
const TOO_LARGE = "生成的应用超过了单个版本的大小上限，请把需求拆小一些。";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* chunked(text: string, size: number, delay: number, signal: AbortSignal) {
  for (let i = 0; i < text.length && !signal.aborted; i += size) {
    yield text.slice(i, i + size);
    await sleep(delay);
  }
}

export async function* runAgents(input: AgentInput): AsyncGenerator<PipelineEvent, AgentResult> {
  const config = appConfig().llm;
  const reviewMode = appConfig().review.mode;
  const { prompt, currentHtml, history, signal } = input;
  const engineerModel = input.model || config.model;
  // Streamed output is cut off once it can no longer be saved, which also bounds the memory a
  // job's event log can take.
  const maxCodeBytes = appConfig().storage.maxHtmlBytes;
  const client = config.mock ? null : new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 1 });

  try {
    // 1. Planner
    yield { type: "stage", agent: "planner", status: "start" };
    const plannerUser = plannerRequest(prompt, history, Boolean(currentHtml));
    let rawPlan = "";
    const planStream = client
      ? streamChat(
          client,
          config.plannerModel || engineerModel,
          [
            { role: "system", content: PLANNER_SYSTEM },
            { role: "user", content: plannerUser },
          ],
          signal,
        )
      : chunked(mockPlan(prompt, Boolean(currentHtml)), 6, 25, signal);
    for await (const delta of planStream) {
      if (isThought(delta)) {
        yield { type: "thinking", agent: "planner", delta: delta.thinking };
        continue;
      }
      if (rawPlan.length > MAX_NOTE_CHARS) break;
      rawPlan += delta;
      yield { type: "plan", delta };
    }
    const { title, plan } = splitPlan(rawPlan);
    yield { type: "stage", agent: "planner", status: "done" };

    // 2. Engineer
    yield { type: "stage", agent: "engineer", status: "start" };
    const engineerUser = [
      engineerRequest(prompt, history, Boolean(currentHtml)),
      `产品经理的计划：\n${plan}`,
      currentHtml ? `现有代码（请在此基础上修改并输出完整文件）：\n${currentHtml}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Context is rebuilt from scratch every turn: the request, the plan and the current code.
    // The chat transcript is never replayed (only the last few requests go to the planner), so a
    // long conversation cannot overflow the model; only the app's own size can.
    if (engineerUser.length > config.maxContextChars) {
      throw new Error("这个应用的代码已经超过单次可处理的长度，请新建项目，或先让它精简、拆分功能。");
    }
    const messages: Chat[] = [
      { role: "system", content: ENGINEER_SYSTEM },
      { role: "user", content: engineerUser },
    ];
    let rawCode = "";
    // The limit is in bytes, and a character of Chinese text takes three.
    let codeBytes = 0;
    const state = { truncated: false };
    const codeStream = client
      ? streamChat(client, engineerModel, messages, signal, state)
      : chunked(mockHtml(prompt, title, currentHtml), 90, 12, signal);
    for await (const delta of codeStream) {
      if (isThought(delta)) {
        yield { type: "thinking", agent: "engineer", delta: delta.thinking };
        continue;
      }
      rawCode += delta;
      codeBytes += Buffer.byteLength(delta);
      if (codeBytes > maxCodeBytes) throw new Error(TOO_LARGE);
      yield { type: "code", delta };
    }

    // If the model ran out of output tokens mid-document, let it continue once.
    if (client && state.truncated && !rawCode.toLowerCase().includes("</html>")) {
      yield { type: "stage", agent: "engineer", status: "start", note: "输出被截断，正在续写" };
      const resume = streamChat(
        client,
        engineerModel,
        [
          ...messages,
          { role: "assistant", content: rawCode },
          { role: "user", content: "输出在中途被截断了。请从刚才中断的位置紧接着继续输出剩余内容，不要重复已输出的部分，不要加任何说明。" },
        ],
        signal,
      );
      for await (const delta of resume) {
        if (isThought(delta)) {
          yield { type: "thinking", agent: "engineer", delta: delta.thinking };
          continue;
        }
        rawCode += delta;
        codeBytes += Buffer.byteLength(delta);
        if (codeBytes > maxCodeBytes) throw new Error(TOO_LARGE);
        yield { type: "code", delta };
      }
    }
    yield { type: "stage", agent: "engineer", status: "done" };
    let html = extractHtml(rawCode);

    // 3. Reviewer: read the code against the request; blocking findings get one fix pass.
    // Scripts that do not even parse are added to the findings as fact, whatever the reviewer says.
    let review: Review | null = null;
    const broken = checkScripts(html);
    if (reviewMode !== "off") {
      yield { type: "stage", agent: "reviewer", status: "start" };
      let rawReview = "";
      const reviewStream = client
        ? streamChat(
            client,
            config.reviewerModel || engineerModel,
            [
              { role: "system", content: REVIEWER_SYSTEM },
              { role: "user", content: `用户需求：\n${prompt}\n\n产品计划：\n${plan}\n\n代码：\n${html}` },
            ],
            signal,
          )
        : chunked("结论：通过", 4, 40, signal);
      for await (const delta of reviewStream) {
        if (isThought(delta)) {
          yield { type: "thinking", agent: "reviewer", delta: delta.thinking };
          continue;
        }
        if (rawReview.length > MAX_NOTE_CHARS) break;
        rawReview += delta;
        yield { type: "review", delta };
      }
      const read = parseReview(rawReview);
      const parsed = { passed: read.passed && broken.length === 0, findings: [...broken, ...read.findings] };
      review = { ...parsed, fixed: false };
      yield {
        type: "stage",
        agent: "reviewer",
        status: "done",
        note: parsed.passed ? "评审通过" : `发现 ${parsed.findings.length} 个问题`,
      };

      if (client && !parsed.passed && reviewMode === "fix") {
        yield { type: "stage", agent: "engineer", status: "start", note: "正在按评审意见修复" };
        yield { type: "code_reset" };
        let fixedRaw = "";
        let fixedBytes = 0;
        const fixStream = streamChat(
          client,
          engineerModel,
          [
            ...messages,
            { role: "assistant", content: html },
            {
              role: "user",
              content: `代码评审发现了以下问题，请逐条修复，并输出修复后的完整 HTML 文件（不要解释）：\n${parsed.findings.map((f) => `- ${f}`).join("\n")}`,
            },
          ],
          signal,
        );
        for await (const delta of fixStream) {
          if (isThought(delta)) {
            yield { type: "thinking", agent: "engineer", delta: delta.thinking };
            continue;
          }
          fixedRaw += delta;
          fixedBytes += Buffer.byteLength(delta);
          if (fixedBytes > maxCodeBytes) break;
          yield { type: "code", delta };
        }
        const fixedHtml = extractHtml(fixedRaw);
        // Only accept the rewrite if it is a complete document that parses no worse than the
        // reviewed draft; otherwise keep the draft.
        if (checkHtml(fixedHtml).length === 0 && checkScripts(fixedHtml).length <= broken.length) {
          html = fixedHtml;
          review.fixed = true;
        } else {
          yield { type: "code_reset" };
          yield { type: "code", delta: html };
        }
        yield {
          type: "stage",
          agent: "engineer",
          status: "done",
          note: review.fixed ? "已按评审修复" : "修复未完成，保留原版本",
        };
      }
    }

    // 4. QA: structure and script syntax of what will be saved.
    yield { type: "stage", agent: "qa", status: "start" };
    const issues = [...checkHtml(html), ...checkScripts(html)];
    yield {
      type: "stage",
      agent: "qa",
      status: "done",
      note: issues.length ? issues.join("；") : "结构与脚本语法检查通过",
    };
    return { plan, title, html, issues, review };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof OpenAI.APIError) throw new ProviderError(describeError(error));
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Race mode building blocks: one shared plan, then several engineers on different models.
// ---------------------------------------------------------------------------------------------

export async function* planStage(input: AgentInput): AsyncGenerator<PipelineEvent, { plan: string; title: string | null }> {
  const config = appConfig().llm;
  const { prompt, currentHtml, history, signal } = input;
  try {
    yield { type: "stage", agent: "planner", status: "start" };
    const user = plannerRequest(prompt, history, Boolean(currentHtml));
    const stream = config.mock
      ? chunked(mockPlan(prompt, Boolean(currentHtml)), 6, 25, signal)
      : streamChat(
          new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 1 }),
          config.plannerModel || input.model || config.model,
          [
            { role: "system", content: PLANNER_SYSTEM },
            { role: "user", content: user },
          ],
          signal,
        );
    let raw = "";
    for await (const delta of stream) {
      if (isThought(delta)) {
        yield { type: "thinking", agent: "planner", delta: delta.thinking };
        continue;
      }
      if (raw.length > MAX_NOTE_CHARS) break;
      raw += delta;
      yield { type: "plan", delta };
    }
    yield { type: "stage", agent: "planner", status: "done" };
    return splitPlan(raw);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof OpenAI.APIError) throw new ProviderError(describeError(error));
    throw error;
  }
}

/** One engineer writing the app on one model. Yields code deltas and thoughts; returns the finished document. */
export async function* engineerStage(input: AgentInput & { plan: string; title: string | null; model: string }): AsyncGenerator<Piece, string> {
  const config = appConfig().llm;
  const { prompt, plan, currentHtml, history, signal } = input;
  const maxBytes = appConfig().storage.maxHtmlBytes;
  const user = [
    engineerRequest(prompt, history, Boolean(currentHtml)),
    `产品经理的计划：\n${plan}`,
    currentHtml ? `现有代码（请在此基础上修改并输出完整文件）：\n${currentHtml}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (user.length > config.maxContextChars) {
    throw new Error("这个应用的代码已经超过单次可处理的长度，请新建项目，或先让它精简、拆分功能。");
  }
  try {
    const stream = config.mock
      ? chunked(mockHtml(`${prompt}（${input.model}）`, input.title, currentHtml), 90, 12 + (input.model.length % 3) * 6, signal)
      : streamChat(
          new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 1 }),
          input.model,
          [
            { role: "system", content: ENGINEER_SYSTEM },
            { role: "user", content: user },
          ],
          signal,
        );
    let raw = "";
    let bytes = 0;
    for await (const delta of stream) {
      if (isThought(delta)) {
        yield delta;
        continue;
      }
      raw += delta;
      bytes += Buffer.byteLength(delta);
      if (bytes > maxBytes) throw new Error(TOO_LARGE);
      yield delta;
    }
    return extractHtml(raw);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof OpenAI.APIError) throw new ProviderError(describeError(error));
    throw error;
  }
}
