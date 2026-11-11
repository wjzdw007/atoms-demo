import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { getUser, startSession } from "@/lib/auth";
import { queryOne, run } from "@/lib/db";
import { reassignJobs } from "@/lib/jobs";
import { adoptGuest } from "@/lib/store";
import { fetchGoogleProfile, googleConfig, OAUTH_STATE_COOKIE } from "@/lib/google";

/** Step 2: verify state, exchange the code server-side, verify the ID token, then sign the user in. */
export async function GET(request: Request) {
  const config = googleConfig(request);
  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);

  const code = params.get("code");
  if (!config.enabled || !code || !expected || params.get("state") !== expected) {
    redirect("/login?error=google_failed");
  }

  let email = "";
  let name = "";
  try {
    ({ email, name } = await fetchGoogleProfile(code, config));
  } catch (error) {
    console.error("Google sign-in failed:", error instanceof Error ? error.message : error);
    redirect("/login?error=google_failed");
  }

  const existing = await queryOne<{ id: string; google_linked: number }>(
    "SELECT id, google_linked FROM users WHERE email = ?",
    [email],
  );
  if (existing) {
    if (!existing.google_linked) {
      // An account from the time of password sign-up, which never verified who owns the address.
      // Google has now proven the owner: end every session issued before letting them in.
      await run("UPDATE users SET google_linked = 1, session_version = session_version + 1 WHERE id = ?", [
        existing.id,
      ]);
    }
    // Signing in to an account that already exists, from a browser that was used as a guest:
    // bring the guest's projects along instead of leaving them behind under an identity that
    // can no longer be reached.
    const current = await getUser();
    if (current?.is_guest && current.id !== existing.id) {
      await adoptGuest(current.id, existing.id);
      reassignJobs(current.id, existing.id);
    }
    await startSession(existing.id);
  } else {
    const current = await getUser();
    if (current?.is_guest) {
      // Keep the guest's projects by upgrading that account in place. The account is now worth
      // more than the guest was, so the guest's token must not carry over: bump the version (any
      // copy of the old token stops working) and issue a fresh one.
      await run(
        "UPDATE users SET email = ?, name = ?, is_guest = 0, google_linked = 1, session_version = session_version + 1 WHERE id = ?",
        [email, name, current.id],
      );
      await startSession(current.id);
    } else {
      const id = nanoid();
      await run(
        "INSERT INTO users (id, email, name, is_guest, google_linked, created_at) VALUES (?, ?, ?, 0, 1, ?)",
        [id, email, name, Date.now()],
      );
      await startSession(id);
    }
  }
  redirect("/");
}
