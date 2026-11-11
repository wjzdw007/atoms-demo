import { request } from "node:https";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

/** Google sign-in is optional: it turns on only when both OAuth credentials are configured. */
export function googleConfig(request?: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const origin = process.env.APP_URL?.replace(/\/$/, "") || (request ? new URL(request.url).origin : "");
  return {
    enabled: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri: `${origin}/api/auth/google/callback`,
  };
}

/** `__Host-` (HTTPS only): the cookie cannot be set or overwritten by a sibling subdomain. */
export const oauthStateCookie = (secure: boolean) => (secure ? "__Host-atoms_oauth_state" : "atoms_oauth_state");

/**
 * Server-to-Google calls. From mainland China these hosts are unreachable, so each one can be
 * pointed at a local TCP relay (e.g. an SSH port-forward to a server abroad) with
 *   GOOGLE_OAUTH_CONNECT=127.0.0.1:8445   -> oauth2.googleapis.com:443
 *   GOOGLE_APIS_CONNECT=127.0.0.1:8446    -> www.googleapis.com:443
 * Only the TCP destination changes: the TLS server name and Host header stay Google's, so the
 * certificate is still verified end to end and the relay never sees the client secret.
 */
function googleRequest(hostname: string, connect: string | undefined, path: string, form?: URLSearchParams) {
  const [host, port] = connect ? connect.split(":") : [hostname, "443"];
  const body = form?.toString();
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = request(
      {
        host,
        port: Number(port),
        servername: hostname,
        path,
        method: body ? "POST" : "GET",
        headers: {
          Host: hostname,
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
            : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            reject(new Error(`Unexpected response from ${hostname} (${res.statusCode})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out reaching ${hostname}`)));
    req.on("error", reject);
    req.end(body);
  });
}

let jwksCache: { keys: JSONWebKeySet; fetchedAt: number } | null = null;
const JWKS_TTL = 60 * 60 * 1000;

async function googleKeys(force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL) return jwksCache.keys;
  const res = await googleRequest("www.googleapis.com", process.env.GOOGLE_APIS_CONNECT, "/oauth2/v3/certs");
  if (res.status !== 200) throw new Error("Could not load Google signing keys");
  jwksCache = { keys: res.json as JSONWebKeySet, fetchedAt: Date.now() };
  return jwksCache.keys;
}

/** Exchanges the authorization code and returns the verified Google profile. */
export async function fetchGoogleProfile(code: string, config: ReturnType<typeof googleConfig>) {
  const token = await googleRequest(
    "oauth2.googleapis.com",
    process.env.GOOGLE_OAUTH_CONNECT,
    "/token",
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  );
  const idToken = (token.json as { id_token?: string }).id_token;
  if (token.status !== 200 || !idToken) throw new Error("Google token exchange failed");

  const options = { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: config.clientId };
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(await googleKeys()), options));
  } catch {
    // Google rotates its keys; retry once with a fresh set before giving up.
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(await googleKeys(true)), options));
  }
  if (!payload.sub) throw new Error("Google ID token has no subject");
  if (!payload.email || payload.email_verified !== true) throw new Error("Google email is not verified");
  const email = String(payload.email).toLowerCase();
  // `sub` never changes and is never reassigned; the address can be renamed or recycled.
  return { sub: String(payload.sub), email, name: String(payload.name || email.split("@")[0]) };
}
