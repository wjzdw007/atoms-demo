import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { secureCookies } from "@/lib/auth";
import { config as appConfig } from "@/lib/config";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { googleConfig, oauthStateCookie } from "@/lib/google";

/** Step 1 of the OAuth authorization-code flow: send the browser to Google's consent screen. */
export async function GET(request: Request) {
  const config = googleConfig(request);
  if (!config.enabled) redirect("/login?error=google_disabled");
  if (!rateLimit(`auth:${await clientIp()}`, appConfig().rateLimit.authPer10Min, 10 * 60_000)) {
    redirect("/login?error=rate_limited");
  }

  const state = nanoid(24);
  const jar = await cookies();
  jar.set(oauthStateCookie(secureCookies), state, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: 600,
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  redirect(url.toString());
}
