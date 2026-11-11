import { beforeAll, describe, expect, it } from "vitest";
import { tempDatabase } from "./helpers";

// No LLM key: the pipeline runs on its canned output, so a whole job can run in a test.
tempDatabase({ DAILY_FREE_USER: "5" });

type Store = typeof import("@/lib/store");
type Db = typeof import("@/lib/db");
type Jobs = typeof import("@/lib/jobs");
let store: Store;
let db: Db;
let jobs: Jobs;

const user = { id: "u1", email: "u1@example.com", name: "u1", is_guest: 0 };

beforeAll(async () => {
  store = await import("@/lib/store");
  db = await import("@/lib/db");
  jobs = await import("@/lib/jobs");
  await db.run("INSERT INTO users (id, email, name, is_guest, created_at) VALUES (?, ?, ?, 0, ?)", [
    user.id,
    user.email,
    user.name,
    Date.now(),
  ]);
  await db.run("INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES ('seed', ?, 3, 'test', ?)", [
    user.id,
    Date.now(),
  ]);
});

async function waitUntilIdle() {
  for (let i = 0; i < 400 && jobs.runningJobCount() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  expect(jobs.runningJobCount()).toBe(0);
}

describe("a generation job", () => {
  it("is recorded while it runs and closed when it finishes", async () => {
    const project = { id: await store.createProject(user.id, "测试"), title: "测试" };
    const charge = await store.chargeGeneration(user);
    if (!charge.ok) throw new Error("charge failed");
    const outcome = await jobs.startJob({
      projectId: project.id,
      userId: user.id,
      projectTitle: project.title,
      prompt: "做一个待办清单",
      charge: charge.source,
    });
    expect(outcome).toBe("started");
    expect(await db.queryOne("SELECT status FROM jobs WHERE project_id = ?", [project.id])).toEqual({ status: "running" });
    expect(await jobs.startJob({ projectId: project.id, userId: user.id, projectTitle: "", prompt: "x", charge: "free" })).toBe("busy");

    await waitUntilIdle();
    expect(await db.queryOne("SELECT status FROM jobs WHERE project_id = ?", [project.id])).toEqual({ status: "done" });
    expect(await store.getLatestVersion(project.id)).not.toBeNull();
    // A finished job is not something a restart should refund.
    expect(await jobs.recoverInterruptedJobs()).toBe(0);
    expect((await store.getQuota(user)).freeLeft).toBe(4);
  }, 30_000);
});

describe("recoverInterruptedJobs", () => {
  it("refunds a job left running by a previous process, once", async () => {
    const project = { id: await store.createProject(user.id, "被中断的项目") };
    const before = await store.getQuota(user);
    const free = await store.chargeGeneration(user);
    const paid = await store.chargeGeneration(user, true);
    expect([free.ok && free.source, paid.ok && paid.source]).toEqual(["free", "credits"]);
    // What a process leaves behind when it dies mid-race: a row still marked running.
    await db.run(
      `INSERT INTO jobs (id, project_id, user_id, prompt, charges, charged_on, status, started_at)
       VALUES ('dead', ?, ?, '做个游戏', '["free","credits"]', ?, 'running', ?)`,
      [project.id, user.id, store.usageDay(), Date.now()],
    );

    expect(await jobs.recoverInterruptedJobs()).toBe(1);
    const after = await store.getQuota(user);
    expect(after.freeLeft).toBe(before.freeLeft);
    expect(after.credits).toBe(before.credits);
    expect(await db.queryOne("SELECT status FROM jobs WHERE id = 'dead'")).toEqual({ status: "interrupted" });
    const messages = await store.listMessages(project.id);
    expect(messages.at(-1)?.content).toContain("额度已退还");

    expect(await jobs.recoverInterruptedJobs()).toBe(0);
    expect((await store.getQuota(user)).credits).toBe(before.credits);
  });
  it("keeps the job open when the refund cannot be written, and refunds it on the next start", async () => {
    const project = { id: await store.createProject(user.id, "退款写不进去的项目") };
    const before = await store.getQuota(user);
    await store.chargeGeneration(user);
    await store.chargeGeneration(user, true);
    await db.run(
      `INSERT INTO jobs (id, project_id, user_id, prompt, charges, charged_on, status, started_at)
       VALUES ('unlucky', ?, ?, '做个游戏', '["free","credits"]', ?, 'running', ?)`,
      [project.id, user.id, store.usageDay(), Date.now()],
    );
    // The database refuses the credit refund, after the free unit was already handed back.
    await db.run(
      `CREATE TRIGGER refuse_refund BEFORE INSERT ON credit_ledger WHEN NEW.reason = 'refund'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    expect(await jobs.recoverInterruptedJobs()).toBe(0);
    // Nothing half-done: the row is still open and neither unit has been given back.
    expect(await db.queryOne("SELECT status FROM jobs WHERE id = 'unlucky'")).toEqual({ status: "running" });
    const during = await store.getQuota(user);
    expect([during.freeLeft, during.credits]).toEqual([before.freeLeft - 1, before.credits - 1]);

    await db.run("DROP TRIGGER refuse_refund");
    expect(await jobs.recoverInterruptedJobs()).toBe(1);
    const after = await store.getQuota(user);
    expect([after.freeLeft, after.credits]).toEqual([before.freeLeft, before.credits]);
    expect(await jobs.recoverInterruptedJobs()).toBe(0);
    expect((await store.getQuota(user)).credits).toBe(before.credits);
  });
});

