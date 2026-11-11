import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { tempDatabase } from "./helpers";

const path = tempDatabase();

describe("migrate", () => {
  it("upgrades a database from before migrations were recorded, and is repeatable", async () => {
    const client = createClient({ url: `file:${path}` });
    // The users table as the first release created it.
    await client.execute(
      `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        session_version INTEGER NOT NULL DEFAULT 0)`,
    );
    await client.execute("INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('old', 'o@example.com', 'hash', 'o', 1)");

    const { migrate } = await import("@/lib/db");
    await migrate(client);
    await migrate(client);

    const user = (await client.execute("SELECT * FROM users WHERE id = 'old'")).rows[0];
    expect(user.password_hash).toBeNull();
    expect(user.google_linked).toBe(0);
    expect(user.session_version).toBe(0);
    const applied = (await client.execute("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id);
    expect(applied).toEqual([
      "001_users_session_version",
      "002_users_google_linked",
      "003_clear_password_hashes",
      "004_versions_unique_number",
      "005_orders_one_pending",
      "006_users_google_sub",
      "007_session_cookie_prefix",
    ]);
    // One user per Google account, enforced by the database.
    await client.execute("UPDATE users SET google_sub = 'g-1' WHERE id = 'old'");
    await expect(
      client.execute("INSERT INTO users (id, email, name, created_at, google_sub) VALUES ('dup', 'd@example.com', 'd', 1, 'g-1')"),
    ).rejects.toThrow();
  });

  it("repairs duplicate version numbers and extra unpaid orders before making them impossible", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(
      "CREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, html TEXT NOT NULL, prompt TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    await client.execute(
      "CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pack_id TEXT NOT NULL, credits INTEGER NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER)",
    );
    // What two saves at the same moment used to leave behind: two versions numbered 2.
    const versions: [string, string, number, number][] = [
      ["a", "p1", 1, 10],
      ["b", "p1", 2, 20],
      ["c", "p1", 2, 21],
      ["d", "p1", 3, 30],
      ["e", "p2", 7, 10],
    ];
    for (const [id, project, number, at] of versions) {
      await client.execute({ sql: "INSERT INTO versions VALUES (?, ?, ?, '', '', ?)", args: [id, project, number, at] });
    }
    for (const [id, status, at] of [["old", "pending", 1], ["new", "pending", 2], ["done", "paid", 3]] as const) {
      await client.execute({ sql: "INSERT INTO orders VALUES (?, 'u', 'starter', 20, 990, ?, 'manual', ?, NULL)", args: [id, status, at] });
    }

    const { migrate } = await import("@/lib/db");
    await migrate(client);

    const numbered = (await client.execute("SELECT id, number FROM versions ORDER BY project_id, number")).rows.map((r) => `${r.id}${r.number}`);
    expect(numbered).toEqual(["a1", "b2", "c3", "d4", "e7"]);
    const orders = (await client.execute("SELECT id FROM orders ORDER BY id")).rows.map((r) => r.id);
    expect(orders).toEqual(["done", "old"]);
    await expect(client.execute("INSERT INTO versions VALUES ('f', 'p1', 4, '', '', 40)")).rejects.toThrow();
    await expect(
      client.execute("INSERT INTO orders VALUES ('again', 'u', 'starter', 20, 990, 'pending', 'manual', 9, NULL)"),
    ).rejects.toThrow();
  });

  it("creates a fresh database without the retired column", async () => {
    const client = createClient({ url: "file::memory:" });
    const { migrate } = await import("@/lib/db");
    await migrate(client);
    const columns = (await client.execute("PRAGMA table_info(users)")).rows.map((r) => r.name);
    expect(columns).not.toContain("password_hash");
    expect(columns).toEqual(expect.arrayContaining(["session_version", "google_linked"]));
  });
});
