import { queryOne } from "@/lib/db";
import { runningJobCount } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/**
 * Liveness check for deploys and monitoring: the process answers and the database is readable.
 * `jobs` is the number of generations in flight, which the deploy script waits on before it
 * restarts the server.
 */
export async function GET() {
  try {
    await queryOne("SELECT 1 AS ok");
    return Response.json({ ok: true, jobs: runningJobCount() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
