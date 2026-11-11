import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Billing } from "@/components/Billing";
import { Brand } from "@/components/Brand";
import { UserMenu } from "@/components/UserMenu";
import { getUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { getQuota, listOrders } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "额度与积分 · Atoms Demo" };

export default async function BillingPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  const { billing, llm } = config();
  const [quota, orders] = await Promise.all([getQuota(user), listOrders(user.id)]);
  return (
    <>
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Brand />
        <UserMenu user={user} />
      </header>
      <Billing
        quota={quota}
        orders={orders.map((o) => ({ ...o, credits: Number(o.credits), amount_cents: Number(o.amount_cents), created_at: Number(o.created_at) }))}
        packs={billing.mode === "off" ? [] : billing.packs}
        mode={billing.mode}
        paymentNote={billing.paymentNote}
        freeModelLabel={llm.models.filter((m) => !m.premium && llm.freeModels.length > 0).map((m) => m.label).join("、")}
        isGuest={Boolean(user.is_guest)}
      />
    </>
  );
}
