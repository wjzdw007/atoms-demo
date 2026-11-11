import { beforeAll, describe, expect, it } from "vitest";
import { tempDatabase } from "./helpers";

tempDatabase({ DAILY_FREE_GUEST: "2", DAILY_FREE_USER: "2", DAILY_FREE_PER_IP: "3", BILLING_MAX_BALANCE: "150" });

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
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "free" });
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "free" });
    expect(await store.chargeGeneration(user)).toEqual({ ok: true, source: "credits" });
    expect(await store.chargeGeneration(user)).toEqual({ ok: false, reason: "empty" });
    expect(await store.getBalance(user.id)).toBe(0);
  });

  it("never covers a premium model with the free allowance", async () => {
    const user = await addUser(member("bob"));
    expect(await store.chargeGeneration(user, true)).toEqual({ ok: false, reason: "empty" });
    await grant(user.id, 1);
    expect(await store.chargeGeneration(user, true)).toEqual({ ok: true, source: "credits" });
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
