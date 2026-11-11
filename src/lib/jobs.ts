import { engineerStage, planStage, ProviderError, runAgents } from "./agents";
import { checkHtml } from "./html";
import { config } from "./config";
import { nanoid } from "nanoid";
import { query, run, withTransaction } from "./db";
import {
  addMessage,
  addVersion,
  clearCandidates,
  getLatestVersion,
  getOwnedProject,
  hasStorageRoom,
  listMessages,
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
 * The event log lives in memory, which fits the single-server deployment this app targets. A
 * multi-instance deployment would move it to a shared store (Redis streams, a DB table).
 *
 * Each job also has a row in the `jobs` table holding what it was charged. A restart loses the
 * running jobs themselves, but on the next start `recoverInterruptedJobs` finds their rows, gives
 * the charges back and tells the user in the project's chat.
 */
export type RaceLane = { model: string; label: string; charge: ChargeSource };

type Job = {
  id: string;
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
 * Race mode only: stop waiting for the models that are still writing and keep the entries that
 * already finished. Outside a race this is the same as a plain stop.
 */
export function finishJob(projectId: string, userId: string) {
  const job = getJob(projectId, userId);
  if (!job?.running) return false;
  job.controller.abort(new Error("finish"));
  return true;
}

/**
 * Starts a job for a project. The caller has already authenticated the user, checked that they
 * own the project and charged the generation; if this does not return "started" the caller
 * refunds that charge.
 */
export async function startJob(opts: {
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
    id: nanoid(),
    projectId: opts.projectId,
    userId: opts.userId,
    prompt: opts.prompt,
    startedAt: Date.now(),
    events: [],
    running: true,
    controller: new AbortController(),
    listeners: new Set(),
  };
  // Claim the project's slot before the first await, so two requests cannot both start a job.
  jobs.set(opts.projectId, job);
  try {
    const charges = opts.race ? opts.race.map((lane) => lane.charge) : [opts.charge];
    await run(
      `INSERT INTO jobs (id, project_id, user_id, prompt, charges, charged_on, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      [job.id, job.projectId, job.userId, job.prompt, JSON.stringify(charges), usageDay(), job.startedAt],
    );
  } catch (error) {
    jobs.delete(opts.projectId);
    console.error("Could not record the job:", error instanceof Error ? error.message : error);
    return "server_limit" as const;
  }
  void (opts.race ? executeRace(job, opts.race) : execute(job, opts));
  return "started" as const;
}

type Outcome = "done" | "failed" | "cancelled";

/**
 * Closes a job's row and gives back the charges it is owed, as one transaction: either the row is
 * closed and every refund is written, or nothing changes and the row stays `running`, to be picked
 * up (and refunded) by the next start. Closing first and refunding afterwards could lose a refund
 * for good if the second step failed. Returns whether this call was the one that closed the row,
 * so a refund can never be made twice.
 */
async function closeJobRecord(
  row: { id: string; userId: string; chargedOn: string },
  status: Outcome | "interrupted",
  refunds: { source: ChargeSource; lane: number }[],
) {
  return withTransaction(async (tx) => {
    const now = Date.now();
    const claim = await tx.execute({
      sql: "UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      args: [status, now, row.id],
    });
    if (claim.rowsAffected === 0) return false;
    for (const refund of refunds) {
      if (refund.source === "free") {
        await tx.execute({
          sql: "UPDATE usage SET count = count - 1 WHERE user_id = ? AND day = ? AND count > 0",
          args: [row.userId, row.chargedOn],
        });
      } else {
        await tx.execute({
          sql: "INSERT INTO credit_ledger (id, user_id, delta, reason, ref, created_at) VALUES (?, ?, 1, 'refund', ?, ?)",
          args: [nanoid(), row.userId, `job:${row.id}:${refund.lane}`, now],
        });
      }
    }
    return true;
  });
}

/** The same for a job of this process; a failure is logged and left for the next start to repair. */
function finishJobRecord(job: Job, outcome: Outcome, chargedOn: string, refunds: { source: ChargeSource; lane: number }[]) {
  return closeJobRecord({ id: job.id, userId: job.userId, chargedOn }, outcome, refunds).catch((error) =>
    console.error("Could not close the job record:", error instanceof Error ? error.message : error),
  );
}

/** A guest signed in to an existing account: their running jobs now belong to that account. */
export function reassignJobs(fromUserId: string, toUserId: string) {
  for (const job of jobs.values()) if (job.userId === fromUserId) job.userId = toUserId;
}

export function runningJobCount() {
  return [...jobs.values()].filter((job) => job.running).length;
}

const INTERRUPTED_NOTE = "服务刚刚重启，这次生成被中断了，本次额度已退还，请重新发送一次。";

/**
 * Runs once when the server starts. Any job row still marked running belongs to a process that
 * is gone: give its charges back and leave a note in the project's chat. Closing the row and
 * refunding happen in one transaction (see closeJobRecord), so the refund is made exactly once:
 * not twice if this runs again, and not zero times if writing it failed halfway.
 */
export async function recoverInterruptedJobs() {
  const rows = await query<{ id: string; project_id: string; user_id: string; charges: string; charged_on: string }>(
    "SELECT id, project_id, user_id, charges, charged_on FROM jobs WHERE status = 'running'",
  );
  let recovered = 0;
  for (const row of rows) {
    // Not stale: this very process is running it (the dev server can register more than once).
    if (jobs.get(row.project_id)?.id === row.id) continue;
    let charges: ChargeSource[] = [];
    try {
      charges = JSON.parse(row.charges);
    } catch {
      /* unreadable row: nothing to refund */
    }
    let closed = false;
    try {
      closed = await closeJobRecord(
        { id: row.id, userId: row.user_id, chargedOn: row.charged_on },
        "interrupted",
        charges.map((source, lane) => ({ source, lane })),
      );
    } catch (error) {
      // Still `running`, so the next start tries again; the other jobs are not held up by it.
      console.error(`Could not refund interrupted job ${row.id}:`, error instanceof Error ? error.message : error);
    }
    if (!closed) continue;
    // The note is a courtesy; the refund above is already final whether or not it can be written.
    if (await getOwnedProject(row.project_id, row.user_id).catch(() => null)) {
      await addMessage(row.project_id, "assistant", INTERRUPTED_NOTE).catch(() => {});
    }
    recovered++;
  }
  // Finished rows are only kept for a while, as a trace of what ran.
  await run("DELETE FROM jobs WHERE status != 'running' AND started_at < ?", [Date.now() - 30 * 24 * 3600 * 1000]);
  return recovered;
}

async function execute(job: Job, opts: { projectTitle: string; charge: ChargeSource; model?: string }) {
  // `job.userId` is read where it is needed rather than copied: it changes if a guest signs in
  // to an existing account while the job is running.
  const { projectId, prompt } = job;
  const signal = job.controller.signal;
  const timeout = setTimeout(() => job.controller.abort(new Error("timeout")), config().generation.timeoutMs);
  // The charge is refunded only when the provider failed. Outcomes the request itself can cause
  // (no usable HTML, output too large, cancel, timeout) still used the model and are not refunded;
  // otherwise a crafted prompt would get unlimited free model output.
  let refund = false;
  let outcome: Outcome = "failed";
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
    if (!(await getOwnedProject(projectId, job.userId))) throw new Error("项目已被删除。");
    if (!(await hasStorageRoom(job.userId, Buffer.byteLength(result.html)))) {
      throw new Error("账号的存储空间已满，这一版没有保存。请先删除一些不用的项目。");
    }

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
    outcome = "done";
    emit(job, { type: "done", version, message, title });
  } catch (error) {
    const stillThere = await getOwnedProject(projectId, job.userId).catch(() => null);
    const note = (text: string) => (stillThere ? addMessage(projectId, "assistant", text).catch(() => {}) : null);
    if (signal.aborted) {
      const timedOut = signal.reason instanceof Error && signal.reason.message === "timeout";
      const text = timedOut
        ? `生成超过了 ${Math.round(config().generation.timeoutMs / 60_000)} 分钟的上限，已自动停止。请把需求拆小一些，或换一个更快的模型。`
        : "已停止生成，本次结果没有保存。";
      if (!timedOut) outcome = "cancelled";
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
    await finishJobRecord(job, outcome, chargedOn, refund ? [{ source: opts.charge, lane: 0 }] : []);
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
  // `job.userId` is read where it is needed rather than copied: it changes if a guest signs in
  // to an existing account while the job is running.
  const { projectId, prompt } = job;
  const signal = job.controller.signal;
  const timeout = setTimeout(() => job.controller.abort(new Error("timeout")), config().generation.timeoutMs);
  const chargedOn = usageDay();
  // Same refund rule as a normal run, applied per lane: only provider-side failures are refunded.
  const refunds = new Set<number>();
  let outcome: Outcome = "failed";
  const reason = () => (signal.aborted && signal.reason instanceof Error ? signal.reason.message : "");
  const timedOut = () => reason() === "timeout";
  /** Ended before every lane finished, but in a way that keeps the finished ones. */
  const cutShort = () => timedOut() || reason() === "finish";
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
            emit(
              job,
              typeof step.value === "string"
                ? { type: "code", delta: step.value, lane: i }
                : { type: "thinking", agent: "engineer", delta: step.value.thinking, lane: i },
            );
            step = await engineer.next();
          }
          // An aborted model stream can end quietly instead of throwing; what it left is not a result.
          if (signal.aborted) throw new Error("aborted");
          html = step.value;
          const problems = checkHtml(html);
          if (problems.length) {
            error = problems.join("；");
            html = "";
          }
        } catch (e) {
          // Running out of time, or the user not waiting any longer, only fails the lanes that
          // were still writing: the ones that already finished are kept. A plain stop ends the race.
          if (signal.aborted && !cutShort()) throw e;
          if (e instanceof ProviderError) refunds.add(i);
          html = "";
          error = timedOut()
            ? `超过 ${Math.round(config().generation.timeoutMs / 60_000)} 分钟还没写完`
            : cutShort()
              ? "还没写完，你选择了不再等它"
              : e instanceof Error
                ? e.message
                : "生成失败";
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        emit(job, {
          type: "stage",
          agent: "engineer",
          status: "done",
          lane: i,
          note: error ?? `${seconds} 秒`,
          failed: Boolean(error),
        });
        return { lane: i, model: lane.model, label: lane.label, seconds, html, error };
      }),
    );
    if (signal.aborted && !cutShort()) throw new Error("aborted");
    if (!(await getOwnedProject(projectId, job.userId))) throw new Error("项目已被删除。");

    if (entries.every((e) => !e.html)) {
      throw new Error(`几个模型都没有生成可用的应用：${entries.map((e) => `${e.label}（${e.error}）`).join("；")}`);
    }
    const candidates = await saveCandidates(projectId, { prompt, ...shared }, entries);
    const board = entries
      .map((e) => (e.html ? `- ${e.label}：${e.seconds} 秒` : `- ${e.label}：失败（${e.error}）`))
      .join("\n");
    const message = await addMessage(projectId, "assistant", `${shared.plan}\n\n🏁 竞速完成，请在右侧挑一版保留：\n${board}`);
    outcome = "done";
    emit(job, { type: "race_done", candidates, message });
  } catch (error) {
    const stillThere = await getOwnedProject(projectId, job.userId).catch(() => null);
    const note = (text: string) => (stillThere ? addMessage(projectId, "assistant", text).catch(() => {}) : null);
    // A timeout that left no usable entry arrives here as an ordinary error naming each lane.
    if (signal.aborted && !(error instanceof Error && error.message.startsWith("几个模型都没有"))) {
      const text = timedOut() ? "竞速超时，已自动停止，没有模型写完。" : "已停止竞速，本次结果没有保存。";
      if (!timedOut()) outcome = "cancelled";
      await note(text);
      emit(job, timedOut() ? { type: "error", message: text } : { type: "cancelled" });
    } else {
      const text = error instanceof Error ? error.message : "生成失败";
      console.error(`Race failed for project ${projectId}:`, text);
      await note(`竞速失败：${text}`);
      emit(job, { type: "error", message: text });
    }
  } finally {
    clearTimeout(timeout);
    await finishJobRecord(
      job,
      outcome,
      chargedOn,
      [...refunds].map((lane) => ({ source: lanes[lane].charge, lane })),
    );
    job.running = false;
    for (const notify of job.listeners) notify();
    setTimeout(() => {
      if (jobs.get(projectId) === job) jobs.delete(projectId);
    }, config().generation.retainMs);
  }
}
