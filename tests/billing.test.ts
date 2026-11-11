import { beforeAll, describe, expect, it } from "vitest";
import { tempDatabase } from "./helpers";

tempDatabase({
  DAILY_FREE_GUEST: "2",
  DAILY_FREE_USER: "2",
  DAILY_FREE_PER_IP: "3",
  BILLING_MAX_BALANCE: "150",
  MAX_PROJECTS_PER_USER: "5",
  MAX_STORAGE_BYTES_PER_USER: "5000",
  MAX_STORAGE_BYTES_PER_GUEST: "1000",
});

type Store = typeof import("@/lib/store");
type Db = typeof import("@/lib/db");
let store: Store;
let db: Db;

const guest = (id: string) => ({ id, email: null, name: "访客", is_guest: 1 });
const member = (id: string) => ({ id, email: `${id}@example.com`, name: id, is_guest: 0 });

async function addUser(user: { id: string; email: string | null; name: string; is_guest: number }) {
  await db.run("INSERT INTO users (id, email, name, is_guest, created_at) VALUES (?, ?, ?, ?, ?)", [
    user.id,
    user.email,
    user.name,
    user.is_guest,
    Date.now(),
  ]);
  return user;
}

async function grant(userId: string, credits: number) {
  await db.run("INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES (?, ?, ?, 'test', ?)", [
    `grant-${userId}-${Math.random()}`,
    userId,
    credits,
    Date.now(),
  ]);
}

beforeAll(async () => {
  store = await import("@/lib/store");
  db = await import("@/lib/db");
});

describe("chargeGeneration", () => {
  it("spends the free allowance first, then credits, then refuses", async () => {
    const user = await addUser(member("alice"));
    await grant(user.id, 1);
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "free", pooled: false });
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "free", pooled: false });
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "credits", pooled: false });
    expect(await store.chargeGeneration(user)).toEqual({ ok: false, reason: "empty" });
    expect(await store.getBalance(user.id)).toBe(0);
  });

  it("never covers a premium model with the free allowance", async () => {
    const user = await addUser(member("bob"));
    expect(await store.chargeGeneration(user, true)).toEqual({ ok: false, reason: "empty" });
    await grant(user.id, 1);
    expect(await store.chargeGeneration(user, true)).toEqual({ ok: true, source: "credits", pooled: false });
    expect((await store.getQuota(user)).freeLeft).toBe(2);
  });

  it("makes guests behind one address share a pool", async () => {
    const [a, b] = [await addUser(guest("g1")), await addUser(guest("g2"))];
    expect((await store.chargeGeneration(a, false, "ip-1")).ok).toBe(true);
    expect((await store.chargeGeneration(a, false, "ip-1")).ok).toBe(true);
    expect((await store.chargeGeneration(b, false, "ip-1")).ok).toBe(true);
    expect(await store.chargeGeneration(b, false, "ip-1")).toEqual({ ok: false, reason: "ip" });
  });

  it("does not let two simultaneous requests both spend the last credit", async () => {
    const user = await addUser(member("carol"));
    await grant(user.id, 1);
    const results = await Promise.all([store.chargeGeneration(user, true), store.chargeGeneration(user, true)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await store.getBalance(user.id)).toBe(0);
  });
});

describe("refundGeneration", () => {
  it("gives back a free unit and a credit", async () => {
    const user = await addUser(member("dave"));
    await grant(user.id, 1);
    await store.chargeGeneration(user);
    await store.refundGeneration(user.id, "free");
    expect((await store.getQuota(user)).freeLeft).toBe(2);
    await store.chargeGeneration(user, true);
    await store.refundGeneration(user.id, "credits");
    expect(await store.getBalance(user.id)).toBe(1);
  });
});

describe("releaseGeneration", () => {
  const siteCount = async () =>
    Number((await db.queryOne<{ count: number }>("SELECT count FROM site_usage WHERE day = ?", [store.usageDay()]))?.count ?? 0);

  it("frees the site-wide and shared slots of a race that could not be paid for", async () => {
    // A free lane is charged, then the premium lane fails for lack of credits: nothing runs.
    const user = await addUser(guest("racer"));
    const before = await siteCount();
    const free = await store.chargeGeneration(user, false, "ip-race");
    if (!free.ok) throw new Error("charge failed");
    expect(free.pooled).toBe(true);
    expect(await store.chargeGeneration(user, true, "ip-race")).toEqual({ ok: false, reason: "empty" });
    await store.releaseGeneration(user.id, free, "ip-race");

    expect(await siteCount()).toBe(before);
    expect((await store.getQuota(user)).freeLeft).toBe(2);
    const pool = await db.queryOne<{ count: number }>("SELECT count FROM ip_usage WHERE ip_hash = 'ip-race'");
    expect(Number(pool?.count)).toBe(0);
  });

  it("leaves the site-wide count alone for an ordinary refund", async () => {
    const user = await addUser(member("refunded"));
    await store.chargeGeneration(user);
    const counted = await siteCount();
    await store.refundGeneration(user.id, "free");
    expect(await siteCount()).toBe(counted);
  });
});

describe("versions", () => {
  it("gives simultaneous saves different numbers", async () => {
    const user = await addUser(member("versions"));
    const projectId = await store.createProject(user.id, "并发保存");
    const saved = await Promise.all(Array.from({ length: 6 }, (_, i) => store.addVersion(projectId, `<html>${i}</html>`, `第 ${i} 次`)));
    expect(saved.map((v) => v.number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store.listVersions(projectId)).map((v) => Number(v.number))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("counts storage in bytes, not characters", async () => {
    const user = await addUser(member("bytes"));
    const projectId = await store.createProject(user.id, "中文");
    await store.addVersion(projectId, "中".repeat(100), "x");
    expect(await store.storageUsed(user.id)).toBe(300);
  });
  it("counts the data kept in generated apps too, and gives guests a smaller share", async () => {
    const [user, visitor] = [await addUser(member("hoarder")), await addUser(guest("hoarder-guest"))];
    for (const owner of [user, visitor]) {
      const projectId = await store.createProject(owner.id, "应用");
      await store.addVersion(projectId, "a".repeat(400), "x");
      await db.run("INSERT INTO app_storage (project_id, user_id, data, updated_at) VALUES (?, ?, ?, 1)", [
        projectId,
        owner.id,
        "中".repeat(200),
      ]);
      expect(await store.storageUsed(owner.id)).toBe(1000);
    }
    expect(await store.hasStorageRoom(user.id, 4000)).toBe(true);
    expect(await store.hasStorageRoom(user.id, 4001)).toBe(false);
    expect(await store.hasStorageRoom(visitor.id, 0)).toBe(true);
    expect(await store.hasStorageRoom(visitor.id, 1)).toBe(false);
  });
});

describe("purgeStaleGuests", () => {
  it("removes guests whose session can no longer exist, with everything they own", async () => {
    const longAgo = Date.now() - 40 * 24 * 3600 * 1000;
    const add = async (id: string, isGuest: number, createdAt: number) => {
      await db.run("INSERT INTO users (id, email, name, is_guest, created_at) VALUES (?, ?, ?, ?, ?)", [
        id,
        isGuest ? null : `${id}@example.com`,
        id,
        isGuest,
        createdAt,
      ]);
      const projectId = await store.createProject(id, id);
      const version = await store.addVersion(projectId, "<html></html>", "x");
      await store.addMessage(projectId, "user", "hi");
      await db.run("INSERT INTO app_storage (project_id, user_id, data, updated_at) VALUES (?, ?, '{}', 1)", [projectId, id]);
      return { projectId, version };
    };
    const gone = await add("stale-guest", 1, longAgo);
    const publisher = await add("stale-publisher", 1, longAgo);
    await db.run("UPDATE projects SET published_slug = 'kept', published_version_id = ? WHERE id = ?", [
      publisher.version.id,
      publisher.projectId,
    ]);
    const recent = await add("recent-guest", 1, Date.now());
    const account = await add("old-member", 0, longAgo);

    expect(await store.purgeStaleGuests()).toBe(1);
    for (const table of ["projects", "versions", "messages", "app_storage"]) {
      const column = table === "projects" ? "id" : "project_id";
      expect(await db.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`, [gone.projectId])).toEqual([]);
      for (const kept of [publisher, recent, account]) {
        expect(await db.query(`SELECT 1 FROM ${table} WHERE ${column} = ?`, [kept.projectId])).toHaveLength(1);
      }
    }
    const users = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE id IN ('stale-guest', 'stale-publisher', 'recent-guest', 'old-member') ORDER BY id",
    );
    expect(users.map((u) => u.id)).toEqual(["old-member", "recent-guest", "stale-publisher"]);
    expect(await store.purgeStaleGuests()).toBe(0);
  });
});

describe("addMessage", () => {
  it("writes nothing for a project that no longer exists", async () => {
    await store.addMessage("deleted-project", "assistant", "late note");
    expect(await db.query("SELECT 1 FROM messages WHERE project_id = 'deleted-project'")).toEqual([]);
  });
});

describe("adoptGuest", () => {
  it("moves a guest's projects and app data to the account they sign in to", async () => {
    const [visitor, account] = [await addUser(guest("visitor")), await addUser(member("returning"))];
    const mine = await store.createProject(visitor.id, "访客做的");
    const shared = await store.createProject(account.id, "账号里已有的");
    const put = (project: string, user: string, data: string) =>
      db.run("INSERT INTO app_storage (project_id, user_id, data, updated_at) VALUES (?, ?, ?, 1)", [project, user, data]);
    await put(mine, visitor.id, "guest-data");
    await put(shared, visitor.id, "guest-copy");
    await put(shared, account.id, "account-copy");

    expect(await store.adoptGuest(visitor.id, account.id)).toBe(1);
    expect(await store.getOwnedProject(mine, account.id)).not.toBeNull();
    expect(await store.getOwnedProject(mine, visitor.id)).toBeNull();
    const data = await db.query<{ project_id: string; data: string }>(
      "SELECT project_id, data FROM app_storage WHERE user_id = ? ORDER BY data",
      [account.id],
    );
    // Where both had data for the same app, the account's own copy is the one that stays.
    expect(data.map((row) => row.data)).toEqual(["account-copy", "guest-data"]);
    expect(await db.query("SELECT 1 FROM app_storage WHERE user_id = ?", [visitor.id])).toEqual([]);
  });
});

describe("adoptGuest and the project limit", () => {
  it("moves only as many projects as the account has room for, newest first", async () => {
    const [visitor, account] = [await addUser(guest("many")), await addUser(member("nearly-full"))];
    for (let i = 0; i < 4; i++) await store.createProject(account.id, `已有 ${i}`);
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await store.createProject(visitor.id, `访客 ${i}`);
      await db.run("UPDATE projects SET updated_at = ? WHERE id = ?", [1000 + i, id]);
      made.push(id);
    }
    expect(await store.adoptGuest(visitor.id, account.id)).toBe(1);
    expect(await store.countProjects(account.id)).toBe(5);
    expect(await store.getOwnedProject(made[2], account.id)).not.toBeNull();
    expect(await store.adoptGuest(visitor.id, account.id)).toBe(0);
  });
});

describe("orders", () => {
  it("grants credits exactly once, however often an order is settled", async () => {
    const user = await addUser(member("erin"));
    const order = await store.createOrder(user.id, "starter", "manual");
    if (!("id" in order)) throw new Error("order was not created");
    const results = await Promise.all([store.settleOrderById(order.id!), store.settleOrderById(order.id!)]);
    expect(results.filter((r) => r === "paid")).toHaveLength(1);
    expect(await store.settleOrderById(order.id!)).toBe("already_paid");
    expect(await store.getBalance(user.id)).toBe(20);
  });

  it("allows one open order per account in manual mode", async () => {
    const user = await addUser(member("frank"));
    expect(await store.createOrder(user.id, "starter", "manual")).toHaveProperty("id");
    expect(await store.createOrder(user.id, "pro", "manual")).toEqual({ error: "pending_exists" });
  });

  it("gives two simultaneous requests one order between them", async () => {
    const user = await addUser(member("twice"));
    const results = await Promise.all([
      store.createOrder(user.id, "starter", "manual"),
      store.createOrder(user.id, "starter", "manual"),
    ]);
    expect(results.filter((r) => "id" in r)).toHaveLength(1);
    expect(results.filter((r) => "error" in r && r.error === "pending_exists")).toHaveLength(1);
  });

  it("holds the balance cap when orders are settled at the same moment", async () => {
    // Cap 150, balance 130: each 20-credit order fits on its own, both together do not.
    const user = await addUser(member("capped"));
    await grant(user.id, 130);
    // Two unpaid orders cannot be created through the app any more; put them there directly, as
    // if they had been, to check that settling is safe on its own.
    await db.run("DROP INDEX idx_orders_one_pending");
    for (const id of ["cap-a", "cap-b"]) {
      await db.run(
        "INSERT INTO orders (id, user_id, pack_id, credits, amount_cents, status, provider, created_at) VALUES (?, ?, 'starter', 20, 990, 'pending', 'manual', 1)",
        [id, user.id],
      );
    }
    const results = await Promise.all([store.settleOrderById("cap-a"), store.settleOrderById("cap-b")]);
    expect(results.sort()).toEqual(["over_limit", "paid"]);
    expect(await store.getBalance(user.id)).toBe(150);
    await db.run("DELETE FROM orders WHERE status = 'pending' AND user_id = ?", [user.id]);
    await db.run("CREATE UNIQUE INDEX idx_orders_one_pending ON orders(user_id) WHERE status = 'pending'");
  });

  it("refuses to settle past the balance cap", async () => {
    const user = await addUser(member("grace"));
    await grant(user.id, 100);
    const order = await store.createOrder(user.id, "pro", "manual");
    expect(await store.settleOrderById(order.id!)).toBe("over_limit");
    expect(await store.getBalance(user.id)).toBe(100);
  });

  it("reports an unknown order", async () => {
    expect(await store.settleOrderById("nope")).toBe("missing");
  });
});
