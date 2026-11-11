/**
 * Runs once when the server process starts, before it takes requests. Jobs that were running
 * when the previous process stopped (a deploy, a crash) are settled here: see
 * `recoverInterruptedJobs`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A build runs next to the live server and must not touch its jobs.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { recoverInterruptedJobs } = await import("./lib/jobs");
    const recovered = await recoverInterruptedJobs();
    if (recovered) console.log(`Refunded ${recovered} generation job(s) interrupted by the last restart.`);
  } catch (error) {
    // Never block startup on this; the rows stay marked running and are retried on the next start.
    console.error("Could not recover interrupted jobs:", error instanceof Error ? error.message : error);
  }
  // Guest accounts whose cookie has expired can never be reached again; clear them out now and
  // once a day, so abandoned (or mass-created) guests do not pile up on the disk.
  const purge = async () => {
    try {
      const { purgeStaleGuests } = await import("./lib/store");
      const removed = await purgeStaleGuests();
      if (removed) console.log(`Removed ${removed} expired guest account(s).`);
    } catch (error) {
      console.error("Could not remove expired guests:", error instanceof Error ? error.message : error);
    }
  };
  void purge();
  setInterval(purge, 24 * 3600 * 1000).unref();
}
