import { getUser, jsonError } from "@/lib/auth";
import { cancelOrder } from "@/lib/store";

/** Cancels the caller's own unpaid order. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return jsonError("请先登录", 401);
  if (!(await cancelOrder(id, user.id))) return jsonError("订单不存在或已完成", 404);
  return Response.json({ ok: true });
}
