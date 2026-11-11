"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Pack = { id: string; name: string; credits: number; priceCents: number; note: string };
type OrderRow = { id: string; pack_id: string; credits: number; amount_cents: number; status: string; created_at: number };
type Quota = { freeLimit: number; freeUsed: number; freeLeft: number; credits: number };
type Mode = "off" | "manual" | "mock";

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

export function Billing({
  quota,
  orders,
  packs,
  mode,
  paymentNote,
  freeModelLabel,
  isGuest,
}: {
  quota: Quota;
  orders: OrderRow[];
  packs: Pack[];
  mode: Mode;
  /** Manual mode: how to pay, as configured by the site owner. */
  paymentNote: string;
  /** Name of the only model the free allowance covers; empty when every model is free. */
  freeModelLabel: string;
  isGuest: boolean;
}) {
  const router = useRouter();
  /** Demo mode only: the order awaiting confirmation in the checkout dialog. */
  const [checkout, setCheckout] = useState<{ orderId: string; pack: Pack } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const pending = orders.find((o) => o.status === "pending");
  const packName = (id: string) => packs.find((p) => p.id === id)?.name ?? id;

  async function call(url: string, method: string, body?: unknown) {
    setError("");
    setNotice("");
    setBusy(true);
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    setBusy(false);
    if (!res?.ok) {
      setError(data?.error || "操作失败，请稍后再试。");
      return null;
    }
    return data;
  }

  async function buy(pack: Pack) {
    const data = await call("/api/billing/orders", "POST", { packId: pack.id });
    if (!data) return;
    if (mode === "mock") setCheckout({ orderId: data.orderId, pack });
    else {
      setNotice("订单已提交。确认收款后积分会自动到账。");
      router.refresh();
    }
  }

  async function pay() {
    if (!checkout) return;
    const data = await call(`/api/billing/orders/${checkout.orderId}/pay`, "POST");
    if (!data) return;
    setNotice(`已到账 ${checkout.pack.credits} 积分。`);
    setCheckout(null);
    router.refresh();
  }

  async function cancel(orderId: string) {
    if (!(await call(`/api/billing/orders/${orderId}`, "DELETE"))) return;
    setNotice("订单已取消。");
    router.refresh();
  }

  const used = quota.freeLimit ? Math.round((quota.freeUsed / quota.freeLimit) * 100) : 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-20 sm:px-8">
      <h1 className="mt-6 text-2xl font-medium">额度与积分</h1>
      <p className="mt-2 text-sm text-muted">
        每次生成或修改应用消耗 1 次。{freeModelLabel ? `每天的免费次数只能用于「${freeModelLabel}」，其他模型每次消耗 1 积分；` : "先用每天的免费次数，用完后再扣积分；"}
        因模型服务故障而失败时会自动退还。
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="text-sm text-muted">今日免费次数</div>
          <div className="mt-1 text-3xl font-medium">
            {quota.freeLeft}
            <span className="text-base font-normal text-muted"> / {quota.freeLimit}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent" style={{ width: `${100 - used}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">每天 0 点（UTC）重置。{isGuest && "登录后每天的免费次数更多。"}</p>
        </section>
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="text-sm text-muted">积分余额</div>
          <div className="mt-1 text-3xl font-medium">{quota.credits}</div>
          <p className="mt-5 text-xs text-muted">积分不过期。{freeModelLabel ? "用于更强的模型，或在免费次数用完后继续使用。" : "在免费次数用完后使用。"}</p>
        </section>
      </div>

      {error && <p className="mt-4 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
      {notice && <p className="mt-4 rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">{notice}</p>}

      {mode !== "off" && (
        <section className="mt-10">
          <h2 className="text-base font-medium">补充积分</h2>
          {mode === "mock" && (
            <p className="mt-1 text-xs text-warn">演示支付：订单流程是真实实现，但不连接任何支付渠道，不会产生真实扣款。</p>
          )}
          {mode === "manual" && (
            <p className="mt-1 text-xs text-muted">下单后需要等待管理员确认收款，确认后积分自动到账。</p>
          )}

          {isGuest ? (
            <p className="mt-4 rounded-2xl border border-line bg-panel p-5 text-sm">
              访客账号不能购买积分（换设备会丢失）。
              <Link href="/login" className="ml-1 text-accent underline underline-offset-2">
                先用 Google 登录
              </Link>
            </p>
          ) : pending && mode === "manual" ? (
            <div className="mt-4 rounded-2xl border border-line bg-panel p-5 text-sm">
              <div className="font-medium">
                有一笔订单等待确认：{packName(pending.pack_id)}（{pending.credits} 积分，{yuan(pending.amount_cents)}）
              </div>
              <p className="mt-2 text-muted">
                订单号 <span className="font-mono text-xs text-ink">{pending.id}</span>
              </p>
              {paymentNote && <p className="mt-2 whitespace-pre-wrap">{paymentNote}</p>}
              <button
                onClick={() => cancel(pending.id)}
                disabled={busy}
                className="mt-4 rounded-full border border-line px-4 py-1.5 text-xs hover:bg-raised disabled:opacity-50"
              >
                取消这笔订单
              </button>
            </div>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-3">
              {packs.map((pack) => (
                <li key={pack.id} className="flex flex-col rounded-2xl border border-line bg-panel p-5">
                  <div className="text-sm font-medium">{pack.name}</div>
                  <div className="mt-2 text-2xl font-medium">
                    {pack.credits}
                    <span className="text-sm font-normal text-muted"> 积分</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {yuan(pack.priceCents)} · {pack.note}
                  </div>
                  <button
                    onClick={() => buy(pack)}
                    disabled={busy}
                    className="mt-4 rounded-full bg-accent py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {mode === "manual" ? "下单" : "购买"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {orders.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-medium">订单记录</h2>
          <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-panel text-sm">
            {orders.map((order) => (
              <li key={order.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate">
                  {packName(order.pack_id)} · {order.credits} 积分
                </span>
                <span className="text-muted">{yuan(order.amount_cents)}</span>
                <time className="hidden text-xs text-muted sm:inline" suppressHydrationWarning>
                  {new Date(order.created_at).toLocaleString("zh-CN")}
                </time>
                <span className={order.status === "paid" ? "text-good" : "text-warn"}>
                  {order.status === "paid" ? "已到账" : "待确认"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-10 text-sm">
        <Link href="/" className="text-accent underline underline-offset-2">
          返回首页
        </Link>
      </p>

      {checkout && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-5"
          role="dialog"
          aria-modal="true"
          aria-label="演示支付"
        >
          <div className="w-full max-w-sm rounded-2xl bg-panel p-6 shadow-2xl">
            <div className="text-base font-medium">演示支付</div>
            <p className="mt-1 text-xs text-warn">不会产生真实扣款。</p>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">商品</dt>
                <dd>
                  {checkout.pack.name}（{checkout.pack.credits} 积分）
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">应付</dt>
                <dd className="font-medium">{yuan(checkout.pack.priceCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">订单号</dt>
                <dd className="font-mono text-xs">{checkout.orderId}</dd>
              </div>
            </dl>
            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setCheckout(null)}
                disabled={busy}
                className="flex-1 rounded-full border border-line py-2 text-sm hover:bg-raised"
              >
                取消
              </button>
              <button
                onClick={pay}
                disabled={busy}
                className="flex-1 rounded-full bg-accent py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "处理中…" : "确认支付（演示）"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
