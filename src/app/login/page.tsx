import { Brand } from "@/components/Brand";
import { LoginForm } from "@/components/LoginForm";
import { getUser } from "@/lib/auth";
import { googleConfig } from "@/lib/google";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  google_failed: "Google 登录没有成功，请重试。",
  google_disabled: "这个站点还没有配置 Google 登录。",
  rate_limited: "尝试次数过多，请 10 分钟后再试。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await getUser();
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-5 py-12">
      <Brand />
      <LoginForm
        isGuest={Boolean(user?.is_guest)}
        googleEnabled={googleConfig().enabled}
        error={(error && ERRORS[error]) || ""}
      />
    </main>
  );
}
