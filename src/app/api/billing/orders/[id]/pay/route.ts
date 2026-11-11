import { getUser, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { getBalance, settleOrder } from "@/lib/store";

/**
 * Self-confirming checkout for local demos: confirms an order without any payment, so it only
 * exists when BILLING_MODE=mock and must never be enabled on a public site. In manual mode an
 * administrator confirms orders through /api/admin/orders instead; a real payment provider would
 * call the same `settleOrder` from its signed webhook.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return jsonError("请先登录", 401);
  if (config().billing.mode !== "mock") return jsonError("当前支付方式不支持直接确认", 403);
  if (user.is_guest) return jsonError("请先用 Google 登录", 403);

  const outcome = await settleOrder(id, user.id);
  if (outcome === "missing") return jsonError("订单不存在", 404);
  if (outcome === "over_limit") return jsonError("积分已接近账户上限，请先使用一些再购买。", 409);
  return Response.json({ status: outcome, credits: await getBalance(user.id) });
}
