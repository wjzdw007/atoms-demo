import { getUser, jsonError } from "@/lib/auth";
import { config } from "@/lib/config";
import { getQuota, listOrders } from "@/lib/store";

/** The signed-in user's allowance, credit balance, available packs and recent orders. */
export async function GET() {
  const user = await getUser();
  if (!user) return jsonError("请先登录", 401);
  const { billing } = config();
  const [quota, orders] = await Promise.all([getQuota(user), listOrders(user.id)]);
  return Response.json({
    quota,
    orders,
    packs: billing.mode === "off" ? [] : billing.packs,
    mode: billing.mode,
    paymentNote: billing.paymentNote,
    canPurchase: billing.mode !== "off" && !user.is_guest,
  });
}
