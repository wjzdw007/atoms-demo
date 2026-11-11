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
}
