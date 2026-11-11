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
    expect(applied).toEqual(["001_users_session_version", "002_users_google_linked", "003_clear_password_hashes"]);
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
