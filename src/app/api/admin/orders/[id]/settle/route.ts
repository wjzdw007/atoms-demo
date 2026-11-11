import { adminGuard } from "@/lib/admin";
import { settleOrderById } from "@/lib/store";

/** Confirms that an order was paid and grants its credits (exactly once). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = adminGuard(request);
  if (denied) return denied;
  const { id } = await params;
  const outcome = await settleOrderById(id);
  if (outcome === "missing") return Response.json({ error: "order not found" }, { status: 404 });
  return Response.json({ status: outcome });
}
