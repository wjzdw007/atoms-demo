import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { nanoid } from "nanoid";
import { config } from "./config";
import { queryOne, run } from "./db";
import { clientIp, rateLimit } from "./rate-limit";
import type { User } from "./types";

const COOKIE = "atoms_session";
const MAX_AGE = 60 * 60 * 24 * config().auth.sessionDays;

/** See `config().auth.secureCookies`. */
export const secureCookies = config().auth.secureCookies;

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production");
  }
  return new TextEncoder().encode(value || "dev-only-secret-change-me");
}

export async function startSession(userId: string) {
  const row = await queryOne<{ session_version: number }>("SELECT session_version FROM users WHERE id = ?", [userId]);
  const token = await new SignJWT({ sub: userId, v: Number(row?.session_version ?? 0) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: MAX_AGE,
  });
}

/** Signs out everywhere: tokens issued before this moment stop being accepted. */
export async function endSession() {
  const user = await getUser();
  if (user) await revokeSessions(user.id);
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function revokeSessions(userId: string) {
  await run("UPDATE users SET session_version = session_version + 1 WHERE id = ?", [userId]);
}

export async function getUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    const row = await queryOne<User & { session_version: number }>(
      "SELECT id, email, name, is_guest, session_version FROM users WHERE id = ?",
      [payload.sub],
    );
    if (!row || Number(row.session_version) !== Number(payload.v ?? 0)) return null;
    return { id: row.id, email: row.email, name: row.name, is_guest: row.is_guest };
  } catch {
    return null;
  }
}

export class GuestLimitError extends Error {}

export async function createGuest(): Promise<User> {
  if (!rateLimit(`guest:${await clientIp()}`, config().rateLimit.guestsPerHour, 60 * 60_000)) {
    throw new GuestLimitError("这个网络创建的访客账号过多，请登录后继续使用。");
  }
  const id = nanoid();
  const name = `访客 ${id.slice(0, 4)}`;
  await run("INSERT INTO users (id, name, is_guest, created_at) VALUES (?, ?, 1, ?)", [id, name, Date.now()]);
  await startSession(id);
  return { id, email: null, name, is_guest: 1 };
}

/** Returns the signed-in user, creating a guest account on first use so nobody hits a login wall. */
export async function getOrCreateUser(): Promise<User> {
  return (await getUser()) ?? (await createGuest());
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
