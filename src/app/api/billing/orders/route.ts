import { getUser, jsonError } from "@/lib/auth";
import { readJson } from "@/lib/body";
import { config } from "@/lib/config";
import { createOrder, getBalance } from "@/lib/store";

/** Creates a pending order for a credit pack. Payment is confirmed separately. */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return jsonError("请先登录", 401);
  const { billing } = config();
  if (billing.mode === "off") return jsonError("当前未开放购买", 403);
  if (user.is_guest) return jsonError("请先用 Google 登录再购买，这样积分才不会丢失。", 403);

  const body = await readJson(request);
  const pack = billing.packs.find((p) => p.id === String(body?.packId ?? ""));
  if (!pack) return jsonError("套餐不存在");
  if ((await getBalance(user.id)) + pack.credits > billing.maxBalance) {
    return jsonError(`账户积分上限为 ${billing.maxBalance}，请先使用一些再购买。`);
  }

  const created = await createOrder(user.id, pack.id, billing.mode);
  if ("error" in created) {
    return created.error === "pending_exists"
      ? jsonError("你有一笔订单还在等待确认，请等它到账，或先取消它。", 409)
      : jsonError("套餐不存在");
  }
  return Response.json({ orderId: created.id, pack, mode: billing.mode, paymentNote: billing.paymentNote });
}
