import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the app at a fresh SQLite file. Call before importing anything from `@/lib`, because
 * the database and config are read from the environment on first use. Each test file runs in its
 * own worker, so files do not share a database.
 */
export function tempDatabase(env: Record<string, string> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "atoms-test-")), "test.db");
  process.env.DATABASE_URL = `file:${path}`;
  delete process.env.LLM_API_KEY;
  Object.assign(process.env, env);
  return path;
}
