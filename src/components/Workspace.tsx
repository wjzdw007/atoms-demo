"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { PENDING_KEY } from "@/components/Home";
import { Mascot, type TeamName } from "@/components/Mascot";
import { extractHtml } from "@/lib/html";
import type { AgentEvent, AgentName, JobSnapshot, Message, RaceCandidate, VersionMeta } from "@/lib/types";

import { defaultRaceModels, ModelControls, nextRaceModels, RaceLanePicker, savedModel, type ModelChoice } from "@/components/ModelControls";
const PreviewFrame = dynamic(() => import("@/components/PreviewFrame"), { ssr: false });

const AGENTS: { key: AgentName; name: string; role: string; doing: string }[] = [
  { key: "planner", name: "Emma", role: "产品经理", doing: "正在梳理需求与功能点" },
  { key: "engineer", name: "Alex", role: "工程师", doing: "正在编写应用代码" },
  { key: "reviewer", name: "Bob", role: "代码评审", doing: "正在对照需求检查代码" },
  { key: "qa", name: "质检", role: "规则检查", doing: "正在检查页面结构" },
];

type StageState = Partial<Record<AgentName, { status: "start" | "done"; note?: string }>>;
/** The tail of what a model is reasoning about right now; gone as soon as it starts answering. */
type Thinking = { agent: AgentName; text: string; chars: number };
type Run = {
  plan: string;
  code: string;
  review: string;
  stages: StageState;
  startedAt: number;
  thinking: Thinking | null;
  /** When the server last sent anything, to tell "slow" from "silent". */
  lastEventAt: number;
};
const THINKING_TAIL = 1500;
const hasBody = (code: string) => /<body[\s>]/i.test(code);
type ProjectInfo = { id: string; title: string; publishedSlug: string | null; publishedVersionId: string | null };
/** One entry of a race as shown in the workspace: streaming first, then waiting to be kept. */
type RaceLaneView = {
  model: string;
  label: string;
  code: string;
  html: string;
  done: boolean;
  note?: string;
  id?: string;
  failed?: boolean;
  /** Reasoning shown until the first line of code arrives. */
  thinking?: string;
  thinkingChars?: number;
};
const laneFromCandidate = (c: RaceCandidate): RaceLaneView => ({
  model: c.model,
  label: c.label,
  code: c.html,
  html: c.html,
  done: true,
  note: c.error ?? `${c.seconds} 秒`,
  id: c.id,
  failed: !c.html,
});
/**
 * The first request of a project, handed over from the home page through sessionStorage: the
 * prompt plus the model (or racing models) picked there.
 */
function readPending(raw: string | null): { prompt: string; choice?: ModelChoice } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.prompt === "string") return parsed;
  } catch {
    /* not JSON: a bare prompt */
  }
  return { prompt: raw };
}

export type QuotaInfo = { freeLimit: number; freeLeft: number; credits: number };

const PREVIEW_INTERVAL = 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Workspace({
  project,
  initialMessages,
  initialVersions,
  initialHtml,
  initialJob,
  initialQuota,
  initialCandidates,
  raceMax,
  models,
  mock,
}: {
  project: ProjectInfo;
  initialMessages: Message[];
  initialVersions: VersionMeta[];
  initialHtml: string;
  /** A generation that is still running on the server (e.g. the user navigated away and came back). */
  initialJob: JobSnapshot;
  initialQuota: QuotaInfo;
  /** Race entries from an earlier race that are still waiting for a decision. */
  initialCandidates: RaceCandidate[];
  /** Most models that can race at once; 0 turns race mode off. */
  raceMax: number;
  /** Models the server allows for the engineer; the first one is the default. */
  models: { id: string; label: string; premium: boolean }[];
  mock: boolean;
}) {
  const [title, setTitle] = useState(project.title);
  const [renaming, setRenaming] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [versions, setVersions] = useState(initialVersions);
  const [latestHtml, setLatestHtml] = useState(initialHtml);
  /** A past version being inspected; null means "showing the latest". */
  const [viewing, setViewing] = useState<{ version: VersionMeta; html: string } | null>(null);
  const [run, setRun] = useState<Run | null>(
    initialJob ? { plan: "", code: "", review: "", stages: {}, startedAt: initialJob.startedAt, thinking: null, lastEventAt: initialJob.startedAt }
      : null,
  );
  const [liveHtml, setLiveHtml] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [pane, setPane] = useState<"chat" | "app">(initialJob ? "app" : "chat");
  const [reloadKey, setReloadKey] = useState(0);
  const [published, setPublished] = useState({ slug: project.publishedSlug, versionId: project.publishedVersionId });
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [quota, setQuota] = useState(initialQuota);
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [race, setRace] = useState<RaceLaneView[] | null>(
    initialCandidates.length ? initialCandidates.map(laneFromCandidate) : null,
  );
  const [raceOn, setRaceOn] = useState(false);
  const [raceModels, setRaceModels] = useState<string[]>([]);

  const attachedRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const busy = run !== null;
  const latest = versions[versions.length - 1] ?? null;
  // While regenerating, keep the current app on screen until the new document has started its
  // <body>; before that the stream is only <head>/<style> and would show as a blank page.
  const liveReady = /<body[\s>]/i.test(liveHtml);
  const shownHtml = busy ? (liveReady ? liveHtml : latestHtml || liveHtml) : viewing ? viewing.html : latestHtml;
  const shownCode = busy ? run.code || latestHtml : viewing ? viewing.html : latestHtml;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, run?.plan, run?.review, run?.stages]);

  const refreshQuota = useCallback(async () => {
    const res = await fetch("/api/billing").catch(() => null);
    if (res?.ok) setQuota((await res.json()).quota);
  }, []);

  /**
   * Follows the project's server-side job: replays its events from the start, then streams new
   * ones. The job itself does not depend on this connection, so a dropped stream is simply
   * re-attached from the number of events already seen.
   */
  const attach = useCallback(
    async (startedAt: number) => {
      if (attachedRef.current) return;
      const controller = new AbortController();
      attachedRef.current = controller;
      const current: Run = { plan: "", code: "", review: "", stages: {}, startedAt, thinking: null, lastEventAt: Date.now() };
      setRun({ ...current });
      let seen = 0;
      let ended = false;
      let lastPreview = 0;
      let lanes: RaceLaneView[] = [];
      const lanePreview: number[] = [];

      const handle = (event: AgentEvent) => {
        seen++;
        current.lastEventAt = Date.now();
        if (event.type === "thinking") {
          if (event.lane !== undefined) {
            const lane = lanes[event.lane];
            if (!lane) return;
            lane.thinking = ((lane.thinking ?? "") + event.delta).slice(-THINKING_TAIL);
            lane.thinkingChars = (lane.thinkingChars ?? 0) + event.delta.length;
            setRace([...lanes]);
            return;
          }
          const before = current.thinking?.agent === event.agent ? current.thinking : null;
          current.thinking = {
            agent: event.agent,
            text: ((before?.text ?? "") + event.delta).slice(-THINKING_TAIL),
            chars: (before?.chars ?? 0) + event.delta.length,
          };
          setRun({ ...current });
          return;
        }
        // Anything else from the pipeline means the model has moved on from reasoning.
        if (event.type !== "code" || event.lane === undefined) current.thinking = null;
        if (event.type === "race_start") {
          lanes = event.lanes.map((l) => ({ ...l, code: "", html: "", done: false }));
          current.stages = { ...current.stages, engineer: { status: "start", note: `${lanes.length} 个模型同时编写` } };
          setRace([...lanes]);
        } else if (event.type === "stage" && event.lane !== undefined) {
          const lane = lanes[event.lane];
          if (lane && event.status === "done") {
            lane.done = true;
            lane.failed = event.failed;
            lane.thinking = undefined;
            lane.note = event.note;
            lane.html = extractHtml(lane.code);
            setRace([...lanes]);
          }
        } else if (event.type === "code" && event.lane !== undefined) {
          const lane = lanes[event.lane];
          if (lane) {
            lane.thinking = undefined;
            lane.code += event.delta;
            if (Date.now() - (lanePreview[event.lane] ?? 0) > PREVIEW_INTERVAL * 2) {
              lanePreview[event.lane] = Date.now();
              // Until the body starts there is nothing to see: a preview now would be a blank page.
              if (hasBody(lane.code)) lane.html = extractHtml(lane.code);
              setRace([...lanes]);
            }
          }
          return;
        } else if (event.type === "race_done") {
          ended = true;
          setRace(event.candidates.map(laneFromCandidate));
          setMessages((list) => [...list, event.message]);
          return;
        } else if (event.type === "stage") {
          current.stages = { ...current.stages, [event.agent]: { status: event.status, note: event.note } };
        } else if (event.type === "plan") {
          current.plan += event.delta;
        } else if (event.type === "review") {
          current.review += event.delta;
        } else if (event.type === "code_reset") {
          current.code = "";
          setLiveHtml("");
        } else if (event.type === "code") {
          current.code += event.delta;
          if (Date.now() - lastPreview > PREVIEW_INTERVAL) {
            lastPreview = Date.now();
            if (hasBody(current.code)) setLiveHtml(extractHtml(current.code));
          }
        } else if (event.type === "done") {
          ended = true;
          setLatestHtml(extractHtml(current.code));
          setVersions((list) => [...list, event.version]);
          setMessages((list) => [...list, event.message]);
          setTitle(event.title);
          return;
        } else if (event.type === "error") {
          ended = true;
          setError(event.message);
          return;
        } else if (event.type === "cancelled") {
          ended = true;
          setError("已停止生成，本次结果没有保存。");
          return;
        }
        setRun({ ...current });
      };

      let gone = false;
      for (let attempt = 0; attempt < 6 && !ended && !controller.signal.aborted; attempt++) {
        try {
          const res = await fetch(`/api/projects/${project.id}/generate?from=${seen}`, { signal: controller.signal });
          if (res.status === 204) {
            // The job is no longer on the server; its outcome is already saved.
            gone = true;
            break;
          }
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) handle(JSON.parse(line) as AgentEvent);
          }
          attempt = -1; // a healthy stream resets the retry budget
        } catch {
          if (controller.signal.aborted) return;
          await sleep(800 * (attempt + 1));
        }
      }

      if (controller.signal.aborted) return;
      attachedRef.current = null;
      if (!ended) {
        if (gone) return window.location.reload();
        setError("与服务器的连接中断了。任务仍在后台运行，刷新页面可以继续查看。");
      }
      setRun(null);
      void refreshQuota();
    },
    [project.id, refreshQuota],
  );

  const send = useCallback(
    async (text: string, choice?: ModelChoice) => {
      const prompt = text.trim();
      if (!prompt || attachedRef.current) return;
      setError("");
      setNeedCredits(false);
      setRuntimeError("");
      const res = await fetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `choice` carries what was picked on the home page; otherwise use this page's controls.
        body: JSON.stringify(
          choice
            ? { prompt, ...choice }
            : raceOn && raceModels.length >= 2
              ? { prompt, models: raceModels }
              : { prompt, model },
        ),
      }).catch(() => null);
      if (!res?.ok) {
        const data = await res?.json().catch(() => ({}));
        setError(data?.error || "发送失败，请检查网络后重试。");
        setNeedCredits(res?.status === 402);
        // A request handed over from the home page never reached the input box here: put it
        // there, with the same race setup, so it can be adjusted and sent again.
        if (choice) {
          setInput(prompt);
          if (choice.models) {
            setRaceModels(choice.models);
            setRaceOn(true);
          } else if (choice.model) setModel(choice.model);
        }
        return;
      }
      setViewing(null);
      setRace(null);
      setInput("");
      setLiveHtml("");
      setPane("app");
      setMessages((list) => [
        ...list,
        { id: `local-${Date.now()}`, role: "user", content: prompt, version_id: null, created_at: Date.now() },
      ]);
      void attach(Date.now());
    },
    [project.id, attach, model, raceOn, raceModels],
  );

  function toggleRace() {
    if (!raceOn && raceModels.length < 2) setRaceModels(defaultRaceModels(models, quota.credits));
    setRaceOn((on) => !on);
  }
  function toggleRaceModel(id: string) {
    setRaceModels((list) => nextRaceModels(list, id, raceMax));
  }

  async function keepCandidate(candidateId: string) {
    const res = await fetch(`/api/projects/${project.id}/race`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) return setError(data?.error || "采用失败，请重试。");
    setVersions((list) => [...list, data.version]);
    setMessages((list) => [...list, data.message]);
    setLatestHtml(data.html);
    setTitle(data.title);
    setRace(null);
  }

  async function dismissRace() {
    await fetch(`/api/projects/${project.id}/race`, { method: "DELETE" }).catch(() => null);
    setRace(null);
  }

  // Restore the model the user picked last time, if the server still offers it.
  useEffect(() => {
    const saved = savedModel(models, initialQuota.credits);
    if (saved) setTimeout(() => setModel(saved), 0);
  }, [models, initialQuota.credits]);

  // On load: re-attach to a job that is still running, or start the one queued from the home page.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialJob) {
      setTimeout(() => void attach(initialJob.startedAt), 0);
      return;
    }
    const pending = readPending(sessionStorage.getItem(PENDING_KEY(project.id)));
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY(project.id));
      setTimeout(() => void send(pending.prompt, pending.choice), 0);
    }
  }, [project.id, initialJob, attach, send]);

  // Leaving the page only detaches the viewer; the job keeps running on the server.
  useEffect(
    () => () => {
      attachedRef.current?.abort();
      attachedRef.current = null;
      startedRef.current = false;
    },
    [],
  );

  async function stop() {
    await fetch(`/api/projects/${project.id}/generate`, { method: "DELETE" }).catch(() => null);
  }

  /** Race mode: stop waiting for the slower models and choose among the finished ones. */
  async function finishRace() {
    await fetch(`/api/projects/${project.id}/generate?finish=1`, { method: "DELETE" }).catch(() => null);
  }

  async function rename(next: string) {
    setRenaming(false);
    const value = next.trim();
    if (!value || value === title) return;
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: value }),
    });
    if (res.ok) setTitle((await res.json()).title);
    else setError("重命名失败");
  }

  async function viewVersion(id: string) {
    if (busy) return;
    setRuntimeError("");
    if (!latest || id === latest.id) {
      setViewing(null);
      return;
    }
    const version = versions.find((v) => v.id === id);
    if (!version) return;
    const res = await fetch(`/api/projects/${project.id}/versions/${id}`);
    if (!res.ok) return setError("读取版本失败");
    const data = await res.json();
    setViewing({ version, html: data.html });
    setPane("app");
  }

  async function restore() {
    if (!viewing) return;
    const res = await fetch(`/api/projects/${project.id}/versions/${viewing.version.id}`, { method: "POST" });
    if (!res.ok) return setError("恢复失败");
    const data = await res.json();
    setVersions((list) => [...list, data.version]);
    setMessages((list) => [...list, data.message]);
    setLatestHtml(data.html);
    setViewing(null);
  }

  async function publish(unpublish = false) {
    const res = await fetch(`/api/projects/${project.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unpublish }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "发布失败");
    setPublished({ slug: data.slug, versionId: data.versionId });
    setShareOpen(!unpublish);
  }

  const shareUrl = published.slug && typeof window !== "undefined" ? `${window.location.origin}/s/${published.slug}` : "";
  const publishedBehind = Boolean(published.slug && latest && published.versionId !== latest.id);

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([shownCode], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "app"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs ${active ? "bg-raised text-ink" : "text-muted hover:text-ink"}`;
  const outOfUnits = quota.freeLeft <= 0 && quota.credits <= 0;

  return (
    <div className="flex h-dvh flex-col">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Brand compact />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              defaultValue={title}
              maxLength={40}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              aria-label="项目名称"
              className="w-full max-w-xs rounded-md border border-accent bg-bg px-2 py-1 text-sm outline-none"
            />
          ) : (
            <button
              onClick={() => setRenaming(true)}
              title="点击重命名"
              className="max-w-full truncate rounded-md px-1.5 py-1 text-left text-sm font-medium hover:bg-raised"
            >
              {title}
            </button>
          )}
        </div>
        {mock && (
          <span className="hidden rounded-full bg-accent-soft px-2.5 py-0.5 text-xs sm:inline" title="未配置 LLM_API_KEY，使用内置模板">
            演示模式
          </span>
        )}
        <Link
          href="/billing"
          title="查看额度与积分"
          className={`hidden shrink-0 rounded-full px-2.5 py-1 text-xs sm:inline ${
            outOfUnits ? "bg-bad/10 text-bad" : "bg-raised text-muted hover:text-ink"
          }`}
        >
          今日免费 {quota.freeLeft}/{quota.freeLimit}
          {quota.credits > 0 && ` · 积分 ${quota.credits}`}
        </Link>
        {versions.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span className="hidden sm:inline">版本</span>
            <select
              value={viewing?.version.id ?? latest?.id}
              disabled={busy}
              onChange={(e) => viewVersion(e.target.value)}
              className="max-w-40 rounded-md border border-line bg-bg px-2 py-1 text-ink outline-none"
            >
              {[...versions].reverse().map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number}
                  {v.id === latest?.id ? "（最新）" : ""} · {v.prompt.slice(0, 14)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="relative">
          <button
            disabled={!latest || busy}
            onClick={() => (published.slug ? setShareOpen((o) => !o) : publish())}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {published.slug ? (publishedBehind ? "发布 ●" : "已发布") : "发布"}
          </button>
          {shareOpen && published.slug && (
            <div className="absolute right-0 top-10 z-20 w-80 rounded-xl border border-line bg-panel p-4 text-sm shadow-xl shadow-black/10">
              <div className="mb-2 font-medium">应用已发布</div>
              <div className="flex gap-2">
                <input readOnly value={shareUrl} className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1.5 text-xs" />
                <button onClick={copyLink} className="rounded-md border border-line px-2.5 text-xs hover:bg-raised">
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              {publishedBehind && (
                <p className="mt-2 text-xs text-warn">线上仍是旧版本，最新的 v{latest?.number} 还没有发布。</p>
              )}
              <div className="mt-3 flex items-center gap-2 text-xs">
                <a href={shareUrl} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2.5 py-1.5 hover:bg-raised">
                  打开 ↗
                </a>
                {publishedBehind && (
                  <button onClick={() => publish()} className="rounded-md bg-accent px-2.5 py-1.5 text-white">
                    发布 v{latest?.number}
                  </button>
                )}
                <button onClick={() => publish(true)} className="ml-auto text-muted hover:text-bad">
                  取消发布
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Mobile pane switch */}
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel p-1.5 md:hidden">
        <button onClick={() => setPane("chat")} className={`flex-1 ${chip(pane === "chat")}`}>
          对话
        </button>
        <button onClick={() => setPane("app")} className={`flex-1 ${chip(pane === "app")}`}>
          应用
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Chat */}
        <section
          className={`${pane === "chat" ? "flex" : "hidden"} w-full min-w-0 flex-col border-line md:flex md:w-[400px] md:shrink-0 md:border-r`}
        >
          <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 && !busy && (
              <p className="pt-10 text-center text-sm text-muted">在下方描述你想做的应用，智能体团队会开始工作。</p>
            )}
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-white">
                    {message.content}
                  </div>
                </div>
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  version={versions.find((v) => v.id === message.version_id)}
                  onView={viewVersion}
                />
              ),
            )}
            {busy && <RunCard run={run} racing={Boolean(race)} />}
            {error && (
              <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
                {error}
                {needCredits && (
                  <Link href="/billing" className="ml-2 font-medium underline underline-offset-2">
                    去补充积分
                  </Link>
                )}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            className="shrink-0 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <div className="rounded-2xl border border-line bg-panel p-2 focus-within:border-accent">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                disabled={busy}
                maxLength={4000}
                placeholder={latest ? "继续提出修改意见，例如：加一个深色模式开关" : "描述你想做的应用…"}
                className="w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted disabled:opacity-60"
              />
              <div className="flex items-center justify-between px-1">
                {busy ? (
                  <span className="text-xs text-muted">任务在后台运行，离开页面也不会中断</span>
                ) : models.length > 1 && !mock ? (
                  <ModelControls
                    models={models}
                    credits={quota.credits}
                    raceMax={raceMax}
                    raceOn={raceOn}
                    onToggleRace={toggleRace}
                    model={model}
                    onModel={setModel}
                  />
                ) : (
                  <span className="text-xs text-muted">Enter 发送 · Shift+Enter 换行</span>
                )}
                {busy ? (
                  <button type="button" onClick={stop} className="rounded-full border border-line px-4 py-1 text-xs hover:bg-raised">
                    停止
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || (raceOn && (raceModels.length < 2 || raceModels.length > quota.freeLeft + quota.credits))}
                    className="rounded-full bg-accent px-4 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {raceOn ? "开始竞速" : "发送"}
                  </button>
                )}
              </div>
              {raceOn && !busy && models.length > 1 && !mock && (
                <RaceLanePicker
                  models={models}
                  credits={quota.credits}
                  raceMax={raceMax}
                  raceModels={raceModels}
                  unitsLeft={quota.freeLeft + quota.credits}
                  onToggle={toggleRaceModel}
                />
              )}
            </div>
          </form>
        </section>

        {/* App: preview / code */}
        <section className={`${pane === "app" ? "flex" : "hidden"} min-w-0 flex-1 flex-col md:flex`}>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
            <button onClick={() => setTab("preview")} className={chip(tab === "preview")}>
              预览
            </button>
            <button onClick={() => setTab("code")} className={chip(tab === "code")}>
              代码
            </button>
            <div className="flex-1" />
            {tab === "preview" ? (
              <>
                <button onClick={() => setDevice("desktop")} className={chip(device === "desktop")}>
                  桌面
                </button>
                <button onClick={() => setDevice("mobile")} className={chip(device === "mobile")}>
                  手机
                </button>
                <button onClick={() => setReloadKey((k) => k + 1)} className={chip(false)} title="重新加载预览">
                  刷新
                </button>
              </>
            ) : (
              <>
                <span className="px-2 text-xs text-muted">{shownCode.length.toLocaleString()} 字符</span>
                <button onClick={download} disabled={!shownCode} className={chip(false)}>
                  下载 HTML
                </button>
              </>
            )}
          </div>

          {viewing && (
            <div className="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-3 py-1.5 text-xs">
              <span>正在查看历史版本 v{viewing.version.number}</span>
              <button onClick={restore} className="rounded-md bg-accent px-2.5 py-1 text-white">
                恢复为此版本
              </button>
              <button onClick={() => setViewing(null)} className="text-muted hover:text-ink">
                回到最新
              </button>
            </div>
          )}

          {runtimeError && !busy && tab === "preview" && (
            <div className="flex shrink-0 items-center gap-3 border-b border-line bg-bad/10 px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-bad">运行时错误：{runtimeError}</span>
              {!viewing && (
                <button
                  onClick={() => send(`预览时出现运行时错误，请修复：${runtimeError}`)}
                  className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-white"
                >
                  让智能体修复
                </button>
              )}
              <button onClick={() => setRuntimeError("")} className="shrink-0 text-muted hover:text-ink">
                忽略
              </button>
            </div>
          )}

          <div className="relative min-h-0 flex-1 bg-bg">
            {race ? (
              <div className="flex h-full flex-col">
                <div className="flex shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-3 py-1.5 text-xs">
                  <span className="font-medium">🏁 竞速模式</span>
                  <span className="text-muted">{busy ? "几个模型正在同时构建…" : "都可以直接试用。挑一版保留，其余会被丢弃。"}</span>
                  {busy && race.some((lane) => lane.done && !lane.failed) && race.some((lane) => !lane.done) && (
                    <button
                      onClick={finishRace}
                      title="还在写的模型会被放弃，它们用掉的额度不退"
                      className="ml-auto rounded-full border border-accent bg-panel px-2.5 py-0.5 font-medium text-accent hover:bg-accent hover:text-white"
                    >
                      不等了，从写完的里挑
                    </button>
                  )}
                  {!busy && (
                    <button onClick={dismissRace} className="ml-auto text-muted hover:text-bad">
                      都不要
                    </button>
                  )}
                </div>
                <div className="grid min-h-0 flex-1 gap-2 p-2" style={{ gridTemplateColumns: `repeat(${race.length}, minmax(0, 1fr))` }}>
                  {race.map((lane, i) => (
                    <div key={i} className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
                      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-xs">
                        <span className="truncate font-medium">{lane.label}</span>
                        <span className={`ml-auto shrink-0 ${lane.failed ? "text-bad" : lane.done ? "text-good" : "text-muted"}`}>
                          {lane.failed
                            ? "失败"
                            : lane.done
                              ? `完成 · ${lane.note ?? ""}`
                              : lane.code
                                ? `${lane.code.length.toLocaleString()} 字符`
                                : lane.thinking
                                  ? `思考中 · ${(lane.thinkingChars ?? 0).toLocaleString()} 字`
                                  : "等待模型响应"}
                        </span>
                      </div>
                      <div className="min-h-0 flex-1">
                        {lane.failed ? (
                          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-bad">{lane.note}</div>
                        ) : lane.html ? (
                          <PreviewFrame html={lane.html} appId={project.id} streaming={!lane.done} ephemeral />
                        ) : lane.thinking ? (
                          <div className="flex h-full flex-col p-4">
                            <div className="mb-2 shrink-0 text-xs font-medium text-ink">💭 模型正在思考，还没开始写代码</div>
                            <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
                              <div className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{lane.thinking}</div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted">
                            {lane.code ? "正在编写…" : "等待模型响应…"}
                          </div>
                        )}
                      </div>
                      {!busy && lane.id && !lane.failed && (
                        <button
                          onClick={() => keepCandidate(lane.id!)}
                          className="m-2 shrink-0 rounded-full bg-accent py-1.5 text-xs font-medium text-white hover:brightness-110"
                        >
                          采用这一版
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : tab === "preview" ? (
              shownHtml ? (
                <div className={`h-full ${device === "mobile" ? "flex justify-center overflow-auto p-4" : ""}`}>
                  <div
                    className={
                      device === "mobile"
                        ? "h-[720px] max-h-full w-[390px] shrink-0 overflow-hidden rounded-[28px] border-4 border-line"
                        : "h-full"
                    }
                  >
                    <PreviewFrame
                      html={shownHtml}
                      appId={project.id}
                      reloadKey={reloadKey}
                      streaming={busy}
                      onError={setRuntimeError}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted">
                  {!busy
                    ? "还没有生成应用"
                    : run?.code
                      ? `正在写样式和结构（已写 ${run.code.length.toLocaleString()} 字符），页面主体出来后会显示在这里…`
                      : "智能体正在工作，应用马上出现在这里…"}
                </div>
              )
            ) : (
              <pre className="scroll-thin h-full overflow-auto p-4 font-mono text-xs leading-relaxed text-ink/90">
                {shownCode || "（暂无代码）"}
              </pre>
            )}
            {busy && !race && tab === "preview" && shownHtml && (
              <div className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/70 px-3 py-1 text-xs text-white">
                <span className="pulse-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-good align-middle" />
                实时构建中
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  version,
  onView,
}: {
  message: Message;
  version?: VersionMeta;
  onView: (id: string) => void;
}) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-line bg-panel px-3.5 py-2.5 text-sm">
      <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
      {version && (
        <button
          onClick={() => onView(version.id)}
          className="mt-2 rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink"
        >
          查看 v{version.number}
        </button>
      )}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return <span suppressHydrationWarning>{seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}</span>;
}

/** Says so when the server has gone quiet, so a slow model can be told apart from a stuck one. */
function Quiet({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.round((now - since) / 1000);
  if (seconds < 20) return null;
  return (
    <p className="mt-3 rounded-lg bg-[#fff1d6] px-2.5 py-1.5 text-xs text-warn" suppressHydrationWarning>
      模型已经 {seconds} 秒没有新输出。再没有动静会自动停止，并退还这次的额度。
    </p>
  );
}

function RunCard({ run, racing }: { run: Run; racing: boolean }) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-line bg-panel p-3.5 text-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>智能体团队正在工作</span>
        <Elapsed since={run.startedAt} />
      </div>
      <ul className="space-y-2.5">
        {AGENTS.map((agent) => {
          const stage = run.stages[agent.key];
          const working = stage?.status === "start";
          const done = stage?.status === "done";
          return (
            <li key={agent.key} className={stage ? "" : "opacity-40"}>
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    done ? "bg-good/20 text-good" : working ? "bg-accent-soft" : "bg-raised"
                  }`}
                >
                  {done ? "✓" : working ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : ""}
                </span>
                {agent.key !== "qa" && <Mascot name={agent.name as TeamName} size={26} />}
                <span className="font-medium">{agent.name}</span>
                <span className="text-xs text-muted">{agent.role}</span>
                <span className="ml-auto truncate pl-2 text-xs text-muted">
                  {working
                    ? run.thinking?.agent === agent.key
                      ? `正在思考 · ${run.thinking.chars.toLocaleString()} 字`
                      : stage?.note || agent.doing
                    : done
                      ? stage?.note || (agent.key === "engineer" ? `${run.code.length.toLocaleString()} 字符` : "完成")
                      : "等待中"}
                </span>
              </div>
              {agent.key === "planner" && run.plan && (
                <div className="ml-7 mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted">{run.plan}</div>
              )}
              {agent.key === "reviewer" && run.review && (
                <div className="ml-7 mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted">{run.review}</div>
              )}
              {working && run.thinking?.agent === agent.key && (
                <div className="ml-7 mt-1.5 rounded-lg bg-raised/60 px-2.5 py-1.5">
                  <div className="mb-0.5 text-[11px] font-medium text-muted">💭 思考过程（还没开始输出）</div>
                  <div className="flex max-h-24 flex-col justify-end overflow-hidden">
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{run.thinking.text}</div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* In a race the lanes report on their own, and their events do not pass through here. */}
      {!racing && <Quiet key={run.lastEventAt} since={run.lastEventAt} />}
    </div>
  );
}
