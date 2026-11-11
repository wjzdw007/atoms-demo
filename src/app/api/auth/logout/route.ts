import { endSession } from "@/lib/auth";

export async function POST() {
  await endSession();
  return Response.json({ ok: true });
}
