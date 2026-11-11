import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/**
 * Admin API authentication: a static bearer token from ADMIN_TOKEN. Without the variable the
 * admin routes answer 404, so they do not exist on deployments that never set it.
 */
export function adminGuard(request: Request): Response | null {
  const expected = config().admin.token;
  if (!expected) return new Response(null, { status: 404 });
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
