import { engineerStage, planStage, ProviderError, runAgents } from "./agents";
import { checkHtml } from "./html";
import { config } from "./config";
import { run } from "./db";
import {
  addMessage,
  addVersion,
  clearCandidates,
  getLatestVersion,
  getOwnedProject,
  listMessages,
  refundGeneration,
  saveCandidates,
  usageDay,
  type ChargeSource,
} from "./store";
import type { AgentEvent, JobSnapshot } from "./types";

/**
 * Generation jobs run in the server process, detached from the HTTP request that started them.
 * Closing the tab, navigating away or losing the connection does not stop a job; any number of
 * clients can attach later and replay its events from the beginning.
 *
 * Jobs live in memory, which fits the single-server deployment this app targets. A multi-instance
 * or serverless deployment would move the event log to a shared store (Redis streams, a DB table).
 */
export type RaceLane = { model: string; label: string; charge: ChargeSource };

type Job = {
  projectId: string;
  userId: string;
  prompt: string;
  startedAt: number;
  events: AgentEvent[];
  running: boolean;
  controller: AbortController;
  listeners: Set<() => void>;
};

const globalForJobs = globalThis as unknown as { __atomsJobs?: Map<string, Job> };
const jobs = (globalForJobs.__atomsJobs ??= new Map<string, Job>());

export function getJob(projectId: string, userId: string) {
  const job = jobs.get(projectId);
  // Jobs are only visible to the user who started them.
  return job && job.userId === userId ? job : null;
}

export function jobSnapshot(projectId: string, userId: string): JobSnapshot {
  const job = getJob(projectId, userId);
  return job?.running ? { running: true, prompt: job.prompt, startedAt: job.startedAt } : null;
}

function emit(job: Job, event: AgentEvent) {
  job.events.push(event);
  for (const notify of job.listeners) notify();
}

export function cancelJob(projectId: string, userId: string) {
  const job = getJob(projectId, userId);
  if (!job?.running) return false;
  job.controller.abort();
  return true;
}

/**
 * Starts a job for a project. The caller has already authenticated the user, checked that they
 * own the project and charged the generation; if this does not return "started" the caller
 * refunds that charge.
 */
export function startJob(opts: {
  projectId: string;
  userId: string;
  projectTitle: string;
  prompt: string;
  model?: string;
  charge: ChargeSource;
  /** Race mode: one lane per model, each charged separately. */
  race?: RaceLane[];
}) {
  if (jobs.get(opts.projectId)?.running) return "busy" as const;
  const running = [...jobs.values()].filter((j) => j.running);
  const limits = config().generation;
  if (running.filter((j) => j.userId === opts.userId).length >= limits.maxConcurrentPerUser) return "user_limit" as const;
  if (running.length >= limits.maxConcurrent) return "server_limit" as const;
  const job: Job = {
    projectId: opts.projectId,
    userId: opts.userId,
    prompt: opts.prompt,
    startedAt: Date.now(),
    events: [],
    running: true,
    controller: new AbortController(),
    listeners: new Set(),
  };
  jobs.set(opts.projectId, job);
  void (opts.race ? executeRace(job, opts.race) : execute(job, opts));
  return "started" as const;
}

async function execute(job: Job, opts: { projectTitle: string; charge: ChargeSource; model?: string }) {
  const { projectId, userId, prompt } = job;
  const signal = job.controller.signal;
  const timeout = setTimeout(() => job.controller.abort(new Error("timeout")), config().generation.timeoutMs);
  // The charge is refunded only when the provider failed. Outcomes the request itself can cause
  // (no usable HTML, output too large, cancel, timeout) still used the model and are not refunded;
  // otherwise a crafted prompt would get unlimited free model output.
  let refund = false;
  const chargedOn = usageDay();
  try {
    const [latest, messages] = await Promise.all([getLatestVersion(projectId), listMessages(projectId)]);
    const history = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.slice(0, 300))
      .slice(-6);
    await clearCandidates(projectId);
    await addMessage(projectId, "user", prompt);

    const agents = runAgents({ prompt, currentHtml: latest?.html ?? null, history, model: opts.model, signal });
    let step = await agents.next();
    while (!step.done) {
      emit(job, step.value);
      step = await agents.next();
    }
    const result = step.value;
    if (signal.aborted) throw new Error("aborted");

    const lower = result.html.toLowerCase();
    if (!lower.includes("<html") && !lower.includes("<body")) {
      throw new Error("模型没有返回有效的网页代码，请换个说法再试一次。");
    }
    if (Buffer.byteLength(result.html) > config().storage.maxHtmlBytes) {
      throw new Error("生成的应用超过了单个版本的大小上限，请把需求拆小一些。");
    }
    // The project may have been deleted while the job was running.
    if (!(await getOwnedProject(projectId, userId))) throw new Error("项目已被删除。");

    const version = await addVersion(projectId, result.html, prompt);
    let title = opts.projectTitle;
    if (!latest && result.title) {
      title = result.title;
      await run("UPDATE projects SET title = ? WHERE id = ?", [title, projectId]);
    }
    const notes: string[] = [];
    if (result.review) {
      if (result.review.passed) notes.push("✅ 代码评审：通过");
      else {
        notes.push(
          `🔎 代码评审发现 ${result.review.findings.length} 个问题${result.review.fixed ? "，已自动修复" : ""}：\n` +
            result.review.findings.map((f) => `- ${f}`).join("\n"),
        );
      }
    }
    if (result.issues.length) notes.push(`⚠️ 质检提示：${result.issues.join("；")}`);
    const message = await addMessage(projectId, "assistant", [result.plan, ...notes].join("\n\n"), version.id);
    emit(job, { type: "done", version, message, title });
  } catch (error) {
    const stillThere = await getOwnedProject(projectId, userId).catch(() => null);
    const note = (text: string) => (stillThere ? addMessage(projectId, "assistant", text).catch(() => {}) : null);
    if (signal.aborted) {
      const timedOut = signal.reason instanceof Error && signal.reason.message === "timeout";
      const text = timedOut ? "生成超时，已自动停止。" : "已停止生成，本次结果没有保存。";
      await note(text);
      emit(job, timedOut ? { type: "error", message: text } : { type: "cancelled" });
    } else {
      refund = error instanceof ProviderError;
      const text = (error instanceof Error ? error.message : "生成失败") + (refund ? "（本次额度已退还）" : "");
      console.error(`Generation failed for project ${projectId}:`, text);
      await note(`生成失败：${text}`);
      emit(job, { type: "error", message: text });
    }
  } finally {
    clearTimeout(timeout);
    if (refund) await refundGeneration(userId, opts.charge, chargedOn).catch(() => {});
    job.running = false;
    for (const notify of job.listeners) notify();
    // Keep the finished job briefly so a client that was mid-reconnect still gets the ending.
    setTimeout(() => {
      if (jobs.get(projectId) === job) jobs.delete(projectId);
    }, config().generation.retainMs);
  }
}

/**
 * Streams a job's events as NDJSON starting at `from`, then keeps the response open until the job
 * ends. Disconnecting only detaches this listener.
 */
export function streamJob(job: Job, from: number, signal: AbortSignal) {
  const encoder = new TextEncoder();
  let cursor = Math.max(0, Math.min(from, job.events.length));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        job.listeners.delete(pump);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const pump = () => {
        if (closed) return;
        try {
          while (cursor < job.events.length) {
            controller.enqueue(encoder.encode(JSON.stringify(job.events[cursor++]) + "\n"));
          }
        } catch {
          return close();
        }
        if (!job.running) close();
      };
      // Blank lines keep proxies from timing out an idle connection (e.g. while the model thinks).
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          close();
        }
      }, 15_000);
      signal.addEventListener("abort", close);
      job.listeners.add(pump);
      pump();
    },
  });
}

/**
 * Race mode: one shared plan, then one engineer per lane writing at the same time on different
 * models. Nothing is saved as a version here; the finished entries wait as candidates until the
 * user keeps one.
 */
async function executeRace(job: Job, lanes: RaceLane[]) {
  const { projectId, userId, prompt } = job;
  const signal = job.controller.signal;
  const timeout = setTimeout(() => job.controller.abort(new Error("timeout")), config().generation.timeoutMs);
  const chargedOn = usageDay();
  // Same refund rule as a normal run, applied per lane: only provider-side failures are refunded.
  const refunds = new Set<number>();
  try {
    const [latest, messages] = await Promise.all([getLatestVersion(projectId), listMessages(projectId)]);
    const history = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.slice(0, 300))
      .slice(-6);
    await clearCandidates(projectId);
    await addMessage(projectId, "user", prompt);
    const input = { prompt, currentHtml: latest?.html ?? null, history, signal, model: lanes[0].model };

    let shared: { plan: string; title: string | null };
    try {
      const planner = planStage(input);
      let step = await planner.next();
      while (!step.done) {
        emit(job, step.value);
        step = await planner.next();
      }
      shared = step.value;
    } catch (error) {
      // No lane ever ran, so every lane gets its unit back if the provider was at fault.
      if (error instanceof ProviderError) lanes.forEach((_, i) => refunds.add(i));
      throw error;
    }

    emit(job, { type: "race_start", lanes: lanes.map(({ model, label }) => ({ model, label })) });
    const started = Date.now();
    const entries = await Promise.all(
      lanes.map(async (lane, i) => {
        emit(job, { type: "stage", agent: "engineer", status: "start", lane: i });
        let html = "";
        let error: string | undefined;
        try {
          const engineer = engineerStage({ ...input, ...shared, model: lane.model });
          let step = await engineer.next();
          while (!step.done) {
            emit(job, { type: "code", delta: step.value, lane: i });
            step = await engineer.next();
          }
          html = step.value;
          const problems = checkHtml(html);
          if (problems.length) {
            error = problems.join("；");
            html = "";
          }
        } catch (e) {
          if (signal.aborted) throw e;
          if (e instanceof ProviderError) refunds.add(i);
          error = e instanceof Error ? e.message : "生成失败";
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        emit(job, { type: "stage", agent: "engineer", status: "done", lane: i, note: error ?? `${seconds} 秒` });
        return { lane: i, model: lane.model, label: lane.label, seconds, html, error };
      }),
    );
    if (signal.aborted) throw new Error("aborted");
    if (!(await getOwnedProject(projectId, userId))) throw new Error("项目已被删除。");

    if (entries.every((e) => !e.html)) {
      throw new Error(`几个模型都没有生成可用的应用：${entries.map((e) => `${e.label}（${e.error}）`).join("；")}`);
    }
    const candidates = await saveCandidates(projectId, { prompt, ...shared }, entries);
    const board = entries
      .map((e) => (e.html ? `- ${e.label}：${e.seconds} 秒` : `- ${e.label}：失败（${e.error}）`))
      .join("\n");
    const message = await addMessage(projectId, "assistant", `${shared.plan}\n\n🏁 竞速完成，请在右侧挑一版保留：\n${board}`);
    emit(job, { type: "race_done", candidates, message });
  } catch (error) {
    const stillThere = await getOwnedProject(projectId, userId).catch(() => null);
    const note = (text: string) => (stillThere ? addMessage(projectId, "assistant", text).catch(() => {}) : null);
    if (signal.aborted) {
      const timedOut = signal.reason instanceof Error && signal.reason.message === "timeout";
      const text = timedOut ? "竞速超时，已自动停止。" : "已停止竞速，本次结果没有保存。";
      await note(text);
      emit(job, timedOut ? { type: "error", message: text } : { type: "cancelled" });
    } else {
      const text = error instanceof Error ? error.message : "生成失败";
      console.error(`Race failed for project ${projectId}:`, text);
      await note(`竞速失败：${text}`);
      emit(job, { type: "error", message: text });
    }
  } finally {
    clearTimeout(timeout);
    for (const i of refunds) await refundGeneration(userId, lanes[i].charge, chargedOn).catch(() => {});
    job.running = false;
    for (const notify of job.listeners) notify();
    setTimeout(() => {
      if (jobs.get(projectId) === job) jobs.delete(projectId);
    }, config().generation.retainMs);
  }
}
