"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Brand } from "@/components/Brand";

const PreviewFrame = dynamic(() => import("@/components/PreviewFrame"), { ssr: false });

export function ShareView({
  slug,
  projectId,
  title,
  author,
  html,
}: {
  slug: string;
  projectId: string;
  title: string;
  author: string;
  html: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remix() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/share/${slug}/remix`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "复制失败");
      setBusy(false);
      return;
    }
    router.push(`/project/${data.id}`);
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 text-sm">
        <Brand compact />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{title}</span>
          <span className="ml-2 text-xs text-muted">由 {author} 用 Atoms Demo 生成</span>
        </span>
        {error && <span className="text-xs text-bad">{error}</span>}
        <button
          onClick={remix}
          disabled={busy}
          className="shrink-0 rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "正在复制…" : "Remix 这个应用"}
        </button>
      </header>
      {/* The app below is written by a user's prompt, not by this site, and the address bar
          cannot tell a visitor that. Say so, where a page asking for a password would be seen. */}
      <p className="shrink-0 border-b border-line bg-raised px-3 py-1 text-[11px] leading-snug text-muted">
        以下内容由用户生成，与本站无关。请不要在其中输入密码、验证码或支付信息。
      </p>
      <div className="min-h-0 flex-1">
        <PreviewFrame html={html} appId={projectId} />
      </div>
    </div>
  );
}
