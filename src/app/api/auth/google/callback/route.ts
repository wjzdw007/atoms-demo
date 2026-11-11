import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { getUser, secureCookies, startSession } from "@/lib/auth";
import { queryOne, run } from "@/lib/db";
import { reassignJobs } from "@/lib/jobs";
import { adoptGuest } from "@/lib/store";
import { fetchGoogleProfile, googleConfig, oauthStateCookie } from "@/lib/google";

/** Step 2: verify state, exchange the code server-side, verify the ID token, then sign the user in. */
export async function GET(request: Request) {
  const config = googleConfig(request);
  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const stateCookie = oauthStateCookie(secureCookies);
  const expected = jar.get(stateCookie)?.value;
  jar.delete(stateCookie);

  const code = params.get("code");
  if (!config.enabled || !code || !expected || params.get("state") !== expected) {
    redirect("/login?error=google_failed");
  }

  let sub = "";
  let email = "";
  let name = "";
  try {
    ({ sub, email, name } = await fetchGoogleProfile(code, config));
  } catch (error) {
    console.error("Google sign-in failed:", error instanceof Error ? error.message : error);
    redirect("/login?error=google_failed");
  }

  // The account is the Google account (`sub`), whatever its address is today. Accounts from
  // before `sub` was stored are found by address once and tied to it from then on.
  type Found = { id: string; google_linked: number; google_sub: string | null; email: string | null };
  let existing = await queryOne<Found>("SELECT id, google_linked, google_sub, email FROM users WHERE google_sub = ?", [sub]);
  if (existing) {
    if (existing.email !== email) {
      // The address changed at Google. Follow it unless another account here already holds it.
      await run("UPDATE OR IGNORE users SET email = ? WHERE id = ?", [email, existing.id]);
    }
  } else {
    existing = await queryOne<Found>("SELECT id, google_linked, google_sub, email FROM users WHERE email = ?", [email]);
    if (existing?.google_sub) {
      // The address now belongs to a different Google account than the one that owns this
      // account here (a renamed or recycled address). It must not get in.
      console.error("Google sign-in refused: the address is tied to another Google account.");
      redirect("/login?error=google_failed");
    }
    if (existing) await run("UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL", [sub, existing.id]);
  }
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
        "UPDATE users SET email = ?, name = ?, is_guest = 0, google_linked = 1, google_sub = ?, session_version = session_version + 1 WHERE id = ?",
        [email, name, sub, current.id],
      );
      await startSession(current.id);
    } else {
      const id = nanoid();
      await run(
        "INSERT INTO users (id, email, name, is_guest, google_linked, google_sub, created_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
        [id, email, name, sub, Date.now()],
      );
      await startSession(id);
    }
  }
  redirect("/");
}
