import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CSRF guard for the API. Session cookies are SameSite=Lax, which still lets another site (or a
 * generated app inside the sandboxed preview, which may submit forms) send a state-changing
 * request with the cookie attached. Every non-GET API call must therefore come from this site:
 *
 * - Browsers always send `Origin` on such requests; it has to match the host being addressed.
 *   A sandboxed frame sends `Origin: null`, which never matches.
 * - Non-browser clients (curl, scripts) send neither header and are not a CSRF vector, since
 *   they carry no ambient cookies.
 */
export function proxy(request: NextRequest) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return NextResponse.next();
  }
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  let allowed: boolean;
  if (origin !== null) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* "null" or malformed */
    }
    allowed = originHost !== "" && originHost === request.headers.get("host");
  } else {
    allowed = site === null || site === "same-origin" || site === "none";
  }
  if (!allowed) return NextResponse.json({ error: "跨站请求被拒绝" }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
