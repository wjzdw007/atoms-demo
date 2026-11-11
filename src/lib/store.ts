import { nanoid } from "nanoid";
import { config } from "./config";
import { query, queryOne, run, transaction, withTransaction } from "./db";
import type { Message, Project, RaceCandidate, User, VersionMeta } from "./types";

export type ProjectSummary = Project & {
  version_count: number;
  /** The request behind the newest version: what the app currently is, in the user's words. */
  last_prompt: string | null;
  /** Race entries still waiting for the user to keep one. */
  candidate_count: number;
};

export function listProjects(userId: string) {
  return query<ProjectSummary>(
    `SELECT p.*,
       (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count,
       (SELECT v.prompt FROM versions v WHERE v.project_id = p.id ORDER BY v.number DESC LIMIT 1) AS last_prompt,
       (SELECT COUNT(*) FROM race_candidates c WHERE c.project_id = p.id AND c.html != '') AS candidate_count
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
    [userId],
  );
}

export function getOwnedProject(id: string, userId: string) {
  return queryOne<Project>("SELECT * FROM projects WHERE id = ? AND user_id = ?", [id, userId]);
}

export async function createProject(userId: string, title: string, remixedFrom: string | null = null) {
  const id = nanoid(12);
  const now = Date.now();
  await run(
    "INSERT INTO projects (id, user_id, title, remixed_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, title, remixedFrom, now, now],
  );
  return id;
}

/** A project nothing has happened in yet: no request, no version, no race waiting for a pick. */
export async function findBlankProject(userId: string) {
  const row = await queryOne<{ id: string }>(
    `SELECT p.id FROM projects p WHERE p.user_id = ?
       AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.project_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.project_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM race_candidates c WHERE c.project_id = p.id)
     ORDER BY p.updated_at DESC LIMIT 1`,
    [userId],
  );
  return row?.id ?? null;
}

export function listVersions(projectId: string) {
  return query<VersionMeta>(
    "SELECT id, number, prompt, created_at FROM versions WHERE project_id = ? ORDER BY number ASC",
    [projectId],
  );
}

export function getVersion(projectId: string, versionId: string) {
  return queryOne<VersionMeta & { html: string }>(
    "SELECT id, number, prompt, html, created_at FROM versions WHERE project_id = ? AND id = ?",
    [projectId, versionId],
  );
}

export function getLatestVersion(projectId: string) {
  return queryOne<VersionMeta & { html: string }>(
    "SELECT id, number, prompt, html, created_at FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1",
    [projectId],
  );
}

export async function addVersion(projectId: string, html: string, prompt: string): Promise<VersionMeta> {
  const id = nanoid(12);
  const createdAt = Date.now();
  // The number is taken and the row written by one statement, so two saves at the same moment
  // (a restore next to a finishing job, say) cannot both get the same number. The unique index
  // on (project_id, number) backs that up.
  const inserted = await run(
    `INSERT INTO versions (id, project_id, number, html, prompt, created_at)
     SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ? FROM versions WHERE project_id = ?
     RETURNING number`,
    [id, projectId, html, prompt, createdAt, projectId],
  );
  const version: VersionMeta = { id, number: Number(inserted.rows[0].number), prompt, created_at: createdAt };
  await run("UPDATE projects SET updated_at = ? WHERE id = ?", [version.created_at, projectId]);
  await pruneVersions(projectId);
  return version;
}

export function listMessages(projectId: string) {
  return query<Message>(
    // The newest 300 messages, oldest first: enough for any real session, bounded for very long ones.
    `SELECT * FROM (
       SELECT id, role, content, version_id, created_at FROM messages
       WHERE project_id = ? ORDER BY created_at DESC LIMIT 300
     ) ORDER BY created_at ASC`,
    [projectId],
  );
}

export async function addMessage(
  projectId: string,
  role: Message["role"],
  content: string,
  versionId: string | null = null,
): Promise<Message> {
  const message: Message = { id: nanoid(12), role, content, version_id: versionId, created_at: Date.now() };
  await run("INSERT INTO messages (id, project_id, role, content, version_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    message.id,
    projectId,
    role,
    content,
    versionId,
    message.created_at,
  ]);
  return message;
}

/**
 * Keeps a project's history bounded: versions beyond the newest N are deleted, except the one
 * that is currently published. Chat messages keep their text; their "view version" link goes away.
 */
async function pruneVersions(projectId: string) {
  const keep = config().storage.maxVersionsPerProject;
  if (!keep) return;
  const stale = await query<{ id: string }>(
    `SELECT id FROM versions
     WHERE project_id = ?
       AND id NOT IN (SELECT id FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT ?)
       AND id NOT IN (SELECT COALESCE(published_version_id, '') FROM projects WHERE id = ?)`,
    [projectId, projectId, keep, projectId],
  );
  for (const { id } of stale) {
    await run("UPDATE messages SET version_id = NULL WHERE project_id = ? AND version_id = ?", [projectId, id]);
    await run("DELETE FROM versions WHERE project_id = ? AND id = ?", [projectId, id]);
  }
}

export async function countProjects(userId: string) {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?", [userId]);
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Quota and credits
//
// Every generation costs one unit. Units come from the daily free allowance first, then from
// purchased credits. A site-wide daily ceiling bounds the total model bill no matter what.
// ---------------------------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

export type ChargeSource = "free" | "credits";

export async function getBalance(userId: string) {
  const row = await queryOne<{ total: number | null }>(
    "SELECT SUM(delta) AS total FROM credit_ledger WHERE user_id = ?",
    [userId],
  );
  return Number(row?.total ?? 0);
}

export async function getQuota(user: User) {
  const { quota } = config();
  const freeLimit = user.is_guest ? quota.guestDaily : quota.userDaily;
  const row = await queryOne<{ count: number }>("SELECT count FROM usage WHERE user_id = ? AND day = ?", [
    user.id,
    today(),
  ]);
  const freeUsed = Math.min(Number(row?.count ?? 0), freeLimit);
  return { freeLimit, freeUsed, freeLeft: freeLimit - freeUsed, credits: await getBalance(user.id) };
}

/**
 * Takes one unit for a generation. Each step is a single conditional statement, so two
 * simultaneous requests cannot both spend the last unit.
 */
export async function chargeGeneration(
  user: User,
  /** Premium models are never covered by the free allowance. */
  creditsOnly = false,
  /** Pseudonymous client address; guests behind one address share a daily free pool. */
  ipHash = "",
): Promise<
  | { ok: true; source: ChargeSource; /** Also took a slot from the guests' shared pool for this address. */ pooled: boolean }
  | { ok: false; reason: "site" | "empty" | "user_max" | "ip" }
> {
  const { quota } = config();
  const day = today();
  const dayStart = Date.parse(`${day}T00:00:00Z`);

  // Per-account ceiling (free + paid), so one account cannot use up the whole site's budget.
  const [freeRow, paidRow] = await Promise.all([
    queryOne<{ count: number }>("SELECT count FROM usage WHERE user_id = ? AND day = ?", [user.id, day]),
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ? AND reason = 'generation' AND created_at >= ?",
      [user.id, dayStart],
    ),
  ]);
  if (Number(freeRow?.count ?? 0) + Number(paidRow?.n ?? 0) >= quota.userDailyMax) {
    return { ok: false, reason: "user_max" };
  }

  // Reserve a slot under the site-wide ceiling first. A refund after a generation ran leaves this
  // counter alone; only a reservation that never led to a model call is released again.
  const site = await run(
    `INSERT INTO site_usage (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?`,
    [day, quota.siteDaily],
  );
  if (site.rowsAffected === 0) return { ok: false, reason: "site" };

  const freeLimit = user.is_guest ? quota.guestDaily : quota.userDaily;
  const pooled = Boolean(user.is_guest && ipHash && !creditsOnly);
  if (pooled) {
    const ip = await run(
      `INSERT INTO ip_usage (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 WHERE count < ?`,
      [ipHash, day, quota.guestDailyPerIp],
    );
    if (ip.rowsAffected === 0) {
      await run("UPDATE site_usage SET count = count - 1 WHERE day = ? AND count > 0", [day]);
      return { ok: false, reason: "ip" };
    }
  }
  if (freeLimit > 0 && !creditsOnly) {
    const free = await run(
      `INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?`,
      [user.id, day, freeLimit],
    );
    if (free.rowsAffected > 0) return { ok: true, source: "free", pooled };
  }

  const paid = await run(
    `INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
     SELECT ?, ?, -1, 'generation', ?
     WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ?) >= 1`,
    [nanoid(), user.id, Date.now(), user.id],
  );
  if (paid.rowsAffected > 0) return { ok: true, source: "credits", pooled };

  // Nothing was spent and no model call will happen: release the reserved slots again.
  await run("UPDATE site_usage SET count = count - 1 WHERE day = ? AND count > 0", [day]);
  if (pooled) await run("UPDATE ip_usage SET count = count - 1 WHERE ip_hash = ? AND day = ? AND count > 0", [ipHash, day]);
  return { ok: false, reason: "empty" };
}

/**
 * Gives the unit back. Only called for failures the user could not have caused (the model
 * provider erred, or the job never started); the site-wide counter is deliberately left alone.
 */
export async function refundGeneration(userId: string, source: ChargeSource, day = today()) {
  if (source === "free") {
    await run("UPDATE usage SET count = count - 1 WHERE user_id = ? AND day = ? AND count > 0", [userId, day]);
  } else {
    await run("INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, 1, 'refund', ?)", [
      nanoid(),
      userId,
      Date.now(),
    ]);
  }
}

/**
 * Undoes a charge for a generation that never started (another lane of the race could not be
 * paid for, or the job was not accepted). Unlike a refund, this also frees the site-wide slot
 * and the shared guest slot: no model call was made, so nothing was used. Without this, requests
 * that are bound to fail could use up the whole site's daily budget.
 */
export async function releaseGeneration(userId: string, charge: { source: ChargeSource; pooled: boolean }, ipHash = "") {
  const day = today();
  await refundGeneration(userId, charge.source, day);
  await run("UPDATE site_usage SET count = count - 1 WHERE day = ? AND count > 0", [day]);
  if (charge.pooled && ipHash) {
    await run("UPDATE ip_usage SET count = count - 1 WHERE ip_hash = ? AND day = ? AND count > 0", [ipHash, day]);
  }
}

export const usageDay = today;

/** Bytes of saved versions across all of a user's projects. */
export async function storageUsed(userId: string) {
  const row = await queryOne<{ total: number | null }>(
    // LENGTH of text counts characters; the limit is in bytes, and Chinese text is three each.
    `SELECT SUM(LENGTH(CAST(v.html AS BLOB))) AS total FROM versions v
     JOIN projects p ON p.id = v.project_id WHERE p.user_id = ?`,
    [userId],
  );
  return Number(row?.total ?? 0);
}

export async function hasStorageRoom(userId: string, extraBytes = 0) {
  return (await storageUsed(userId)) + extraBytes <= config().storage.maxBytesPerUser;
}

// ---------------------------------------------------------------------------------------------
// Orders (credit packs)
// ---------------------------------------------------------------------------------------------

export type Order = {
  id: string;
  pack_id: string;
  credits: number;
  amount_cents: number;
  status: "pending" | "paid";
  provider: string;
  created_at: number;
  paid_at: number | null;
};

export async function createOrder(userId: string, packId: string, mode: "manual" | "mock") {
  const pack = config().billing.packs.find((p) => p.id === packId);
  if (!pack) return { error: "no_pack" as const };
  // One open order per account, so several pending orders cannot be settled together to get past
  // the balance cap. A self-confirming demo order simply replaces an abandoned one; an order that
  // is waiting for a real payment is never dropped silently.
  // The rule itself is a unique index (one pending order per user), so two requests at the same
  // moment cannot both get an order; the loser's insert fails and is reported like any other.
  const id = nanoid(16);
  const insert = {
    sql: `INSERT INTO orders (id, user_id, pack_id, credits, amount_cents, status, provider, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [id, userId, pack.id, pack.credits, pack.priceCents, mode, Date.now()],
  };
  try {
    if (mode === "mock") {
      await transaction([{ sql: "DELETE FROM orders WHERE user_id = ? AND status = 'pending'", args: [userId] }, insert]);
    } else {
      await run(insert.sql, insert.args);
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) return { error: "pending_exists" as const };
    throw error;
  }
  return { id };
}

/** Lets a buyer withdraw their own order while it is still unpaid. */
export async function cancelOrder(orderId: string, userId: string) {
  const res = await run("DELETE FROM orders WHERE id = ? AND user_id = ? AND status = 'pending'", [orderId, userId]);
  return res.rowsAffected > 0;
}

export function listOrders(userId: string) {
  return query<Order>(
    `SELECT id, pack_id, credits, amount_cents, status, provider, created_at, paid_at
     FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
}

/**
 * Marks an order paid and grants its credits exactly once. The ledger insert only happens if this
 * call is the one that flipped the order from pending to paid, so a repeated or concurrent
 * confirmation (for example a retried payment webhook) cannot grant credits twice.
 */
export async function settleOrder(orderId: string, userId: string) {
  const order = await queryOne<{ credits: number; status: string }>(
    "SELECT credits, status FROM orders WHERE id = ? AND user_id = ?",
    [orderId, userId],
  );
  if (!order) return "missing" as const;
  if (order.status !== "pending") return "already_paid" as const;
  const now = Date.now();
  // The balance cap is checked by the same statement that marks the order paid, inside the
  // transaction: checked beforehand, two orders settled at the same moment would each see the
  // old balance and together go past the cap.
  const results = await transaction([
    {
      sql: `UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'
              AND (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ?) + credits <= ?`,
      args: [now, orderId, userId, userId, config().billing.maxBalance],
    },
    {
      sql: `INSERT INTO credit_ledger (id, user_id, delta, reason, ref, created_at)
            SELECT ?, ?, ?, 'purchase', ?, ?
            WHERE (SELECT paid_at FROM orders WHERE id = ?) = ?
              AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE ref = ? AND reason = 'purchase')`,
      args: [nanoid(), userId, Number(order.credits), orderId, now, orderId, now, orderId],
    },
  ]);
  if (results[1].rowsAffected > 0) return "paid" as const;
  // Nothing was granted: either someone else settled it first, or the cap held it back.
  const after = await queryOne<{ status: string }>("SELECT status FROM orders WHERE id = ?", [orderId]);
  return after?.status === "pending" ? ("over_limit" as const) : ("already_paid" as const);
}

/**
 * Signing in to an existing account while using the site as a guest: the guest's projects and
 * app data move to that account, so "your projects are kept when you sign in" holds here too.
 * Where both already have data for the same app, the account's copy wins. The guest's sessions
 * end with it.
 */
export function adoptGuest(guestId: string, userId: string) {
  return withTransaction(async (tx) => {
    const moved = await tx.execute({ sql: "UPDATE projects SET user_id = ? WHERE user_id = ?", args: [userId, guestId] });
    await tx.execute({ sql: "UPDATE OR IGNORE app_storage SET user_id = ? WHERE user_id = ?", args: [userId, guestId] });
    await tx.execute({ sql: "DELETE FROM app_storage WHERE user_id = ?", args: [guestId] });
    // A job still running for the guest is refunded to the account if a restart cuts it off.
    await tx.execute({ sql: "UPDATE jobs SET user_id = ? WHERE user_id = ? AND status = 'running'", args: [userId, guestId] });
    await tx.execute({ sql: "UPDATE users SET session_version = session_version + 1 WHERE id = ?", args: [guestId] });
    return moved.rowsAffected;
  });
}

/** Admin view: orders waiting for payment confirmation, oldest first. */
export function listPendingOrders() {
  return query<Order & { user_id: string; email: string | null }>(
    `SELECT o.id, o.user_id, u.email, o.pack_id, o.credits, o.amount_cents, o.status, o.provider, o.created_at, o.paid_at
     FROM orders o JOIN users u ON u.id = o.user_id
     WHERE o.status = 'pending' ORDER BY o.created_at ASC LIMIT 200`,
  );
}

/** Admin action: confirm that an order was paid. Same exactly-once guarantee as `settleOrder`. */
export async function settleOrderById(orderId: string) {
  const order = await queryOne<{ user_id: string }>("SELECT user_id FROM orders WHERE id = ?", [orderId]);
  if (!order) return "missing" as const;
  return settleOrder(orderId, order.user_id);
}

// ---------------------------------------------------------------------------------------------
// Race mode candidates
// ---------------------------------------------------------------------------------------------

export function listCandidates(projectId: string) {
  return query<RaceCandidate>(
    `SELECT id, lane, model, label, seconds, html, error FROM race_candidates
     WHERE project_id = ? ORDER BY lane ASC`,
    [projectId],
  ).then((rows) => rows.map((r) => ({ ...r, lane: Number(r.lane), seconds: Number(r.seconds), error: r.error || undefined })));
}

export async function saveCandidates(
  projectId: string,
  shared: { prompt: string; plan: string; title: string | null },
  entries: Omit<RaceCandidate, "id">[],
): Promise<RaceCandidate[]> {
  await clearCandidates(projectId);
  const saved: RaceCandidate[] = [];
  for (const entry of entries) {
    const id = nanoid(12);
    await run(
      `INSERT INTO race_candidates (id, project_id, lane, model, label, seconds, html, error, prompt, plan, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, entry.lane, entry.model, entry.label, entry.seconds, entry.html, entry.error ?? null, shared.prompt, shared.plan, shared.title, Date.now()],
    );
    saved.push({ id, ...entry });
  }
  return saved;
}

export function getCandidate(projectId: string, candidateId: string) {
  return queryOne<{ html: string; label: string; prompt: string; plan: string; title: string | null }>(
    "SELECT html, label, prompt, plan, title FROM race_candidates WHERE project_id = ? AND id = ?",
    [projectId, candidateId],
  );
}

export function clearCandidates(projectId: string) {
  return run("DELETE FROM race_candidates WHERE project_id = ?", [projectId]);
}
