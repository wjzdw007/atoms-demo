import { createHmac } from "node:crypto";
import { headers } from "next/headers";

/**
 * Small fixed-window rate limiter kept in process memory. It is enough to blunt password guessing
 * and guest-account farming on a single server; a multi-instance deployment would back it with a
 * shared store.
 */
const globalForLimits = globalThis as unknown as { __atomsLimits?: Map<string, { count: number; resetAt: number }> };
const buckets = (globalForLimits.__atomsLimits ??= new Map());

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= limit;
}

/**
 * The client address as reported by the reverse proxy. The app only listens on localhost behind
 * nginx, which overwrites X-Real-IP, so this value cannot be spoofed by the client there.
 */
export async function clientIp() {
  const h = await headers();
  return h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** A stable pseudonym for the client address, for counters that must survive restarts. */
export async function clientIpHash() {
  const key = process.env.AUTH_SECRET || "dev-only-secret-change-me";
  return createHmac("sha256", key).update(await clientIp()).digest("hex").slice(0, 32);
}
