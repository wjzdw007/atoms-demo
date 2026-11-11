// Takes a consistent copy of the SQLite database while the app keeps running.
//
//   node --env-file-if-exists=.env.local scripts/backup.mjs <backup-dir> [copies-to-keep]
//
// Run from the app directory. `VACUUM INTO` writes a complete, defragmented copy in one read
// transaction, so the copy is valid even if the app is writing at that moment (copying the file
// with cp is not). To restore: stop the app, put a copy back as data/atoms.db, start the app.
import { createClient } from "@libsql/client";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const url = process.env.DATABASE_URL || "file:./data/atoms.db";
const dir = resolve(process.argv[2] || "./backups");
const keep = Number(process.argv[3] || 30);

if (!url.startsWith("file:")) {
  console.log("DATABASE_URL is a hosted database; back it up with the provider's tools.");
  process.exit(0);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const target = join(dir, `atoms-${stamp}.db`);

if (existsSync(target)) {
  console.log(`${target} was written a moment ago; nothing to do.`);
  process.exit(0);
}

const client = createClient({ url });
await client.execute({ sql: "VACUUM INTO ?", args: [target] });
client.close();
chmodSync(target, 0o600);
console.log(`Backed up to ${target} (${Math.round(statSync(target).size / 1024)} KB)`);

const copies = readdirSync(dir)
  .filter((name) => /^atoms-\d{8}-\d{6}\.db$/.test(name))
  .sort();
for (const name of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, name));
