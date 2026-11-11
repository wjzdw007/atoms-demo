"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/types";

export function UserMenu({ user }: { user: User | null }) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  if (!user) {
    return (
      <Link href="/login" className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:brightness-110">
        登录
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <Link href="/billing" className="text-muted hover:text-ink">
        额度
      </Link>
      <span className="hidden text-muted sm:inline">{user.name}</span>
      {user.is_guest ? (
        <Link href="/login" className="rounded-full bg-raised px-4 py-1.5 font-medium hover:brightness-95">
          登录以保存项目
        </Link>
      ) : (
        <button onClick={logout} className="rounded-full bg-raised px-4 py-1.5 font-medium hover:brightness-95">
          退出
        </button>
      )}
    </div>
  );
}
