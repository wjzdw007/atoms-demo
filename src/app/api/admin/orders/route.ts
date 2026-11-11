import { adminGuard } from "@/lib/admin";
import { listPendingOrders } from "@/lib/store";

/** Orders waiting for an administrator to confirm payment. */
export async function GET(request: Request) {
  const denied = adminGuard(request);
  if (denied) return denied;
  return Response.json({ orders: await listPendingOrders() });
}
