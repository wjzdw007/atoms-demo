import { createClient, type Client, type InArgs } from "@libsql/client";
import { mkdirSync } from "node:fs";

/**
 * One driver for both environments:
 * - local / single-server: a SQLite file (default `file:./data/atoms.db`)
 * - serverless: a hosted libSQL database (DATABASE_URL=libsql://..., DATABASE_AUTH_TOKEN)
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    name TEXT NOT NULL,
    is_guest INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    published_slug TEXT UNIQUE,
    published_version_id TEXT,
    remixed_from TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    html TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, number)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    version_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_storage (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  )`,
  // Append-only ledger of purchased credits: balance = SUM(delta). Never updated in place.
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at)`,
  // Race mode: finished entries waiting for the user to keep one. Cleared when one is kept, when
  // they are dismissed, or when the next generation starts.
  `CREATE TABLE IF NOT EXISTS race_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    lane INTEGER NOT NULL,
    model TEXT NOT NULL,
    label TEXT NOT NULL,
    seconds REAL NOT NULL,
    html TEXT NOT NULL,
    error TEXT,
    prompt TEXT NOT NULL,
    plan TEXT NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_race_project ON race_candidates(project_id, lane)`,
  // Site-wide generation counter per day. Only ever incremented, so refunds cannot lower it.
  `CREATE TABLE IF NOT EXISTS site_usage (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  )`,
  // Free generations by guests per client address per day. The address is stored as a keyed
  // hash, never in the clear.
  `CREATE TABLE IF NOT EXISTS ip_usage (
    ip_hash TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip_hash, day)
  )`,
  `CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,
];

const MIGRATIONS = [
  // Bumped to invalidate every existing session of a user (logout, credential change).
  "ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0",
  // Set once the account's email has been proven through Google sign-in.
  "ALTER TABLE users ADD COLUMN google_linked INTEGER NOT NULL DEFAULT 0",
];

const globalForDb = globalThis as unknown as {
  __atomsDb?: { client: Client; ready: Promise<void> };
};

function init() {
  const url = process.env.DATABASE_URL || "file:./data/atoms.db";
  if (url.startsWith("file:./data/")) mkdirSync("./data", { recursive: true });
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  const ready = (async () => {
    for (const stmt of SCHEMA) await client.execute(stmt);
    // Additive column migrations; "duplicate column" just means it already ran.
    for (const stmt of MIGRATIONS) await client.execute(stmt).catch(() => {});
  })();
  return { client, ready };
}

async function getClient() {
  const state = (globalForDb.__atomsDb ??= init());
  await state.ready;
  return state.client;
}

export async function query<T = Record<string, unknown>>(sql: string, args: InArgs = []): Promise<T[]> {
  const client = await getClient();
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => ({ ...row })) as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, args: InArgs = []): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] ?? null;
}

export async function run(sql: string, args: InArgs = []) {
  const client = await getClient();
  return client.execute({ sql, args });
}

/** Runs several statements atomically (all or nothing). */
export async function transaction(statements: { sql: string; args: InArgs }[]) {
  const client = await getClient();
  return client.batch(statements, "write");
}
