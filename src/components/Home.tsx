"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IntroVideo } from "@/components/IntroVideo";
import { MascotRow } from "@/components/Mascot";
import type { ProjectSummary } from "@/lib/store";

const EXAMPLES = [
  { label: "番茄钟", prompt: "做一个番茄钟应用：25 分钟专注 / 5 分钟休息，可以开始、暂停、重置，记录今天完成了几个番茄，并用环形进度条显示剩余时间。" },
  { label: "记账本", prompt: "做一个个人记账本：可以添加收入和支出（金额、分类、备注），按月查看汇总，用柱状图展示各分类支出占比，数据保存在本地。" },
  { label: "看板", prompt: "做一个三列任务看板（待办 / 进行中 / 已完成），支持新增卡片、拖拽移动卡片、删除卡片，数据保存在本地。" },
  { label: "记忆翻牌", prompt: "做一个记忆翻牌小游戏：4x4 的 emoji 卡片，翻开两张相同则消除，显示步数与用时，通关后可以重新开始。" },
];

export const PENDING_KEY = (id: string) => `atoms:pending:${id}`;

export function Home({ projects, mock }: { projects: ProjectSummary[]; mock: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      // The workspace picks this up and starts the first generation immediately.
      sessionStorage.setItem(PENDING_KEY(data.id), value);
      router.push(`/project/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("确定删除这个项目吗？所有版本都会被删除。")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-20 sm:px-8">
      <section className="pt-12 text-center sm:pt-20">
        <MascotRow />
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">把一句话变成可运行的应用</h1>
        <p className="mx-auto mt-4 max-w-xl text-sm text-muted sm:text-base">
          描述你的想法，Emma、Alex、Bob 接力完成规划、编码与评审，右侧实时预览，随时继续修改、回滚和发布。
        </p>

        <form
          className="mt-8 rounded-3xl border border-line bg-panel p-4 text-left shadow-lg shadow-black/5 focus-within:border-accent"
          onSubmit={(e) => {
            e.preventDefault();
            create(prompt);
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create(prompt);
            }}
            rows={3}
            placeholder="例如：做一个可以记录读书笔记的应用，支持按书名搜索和标签筛选…"
            className="w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-between gap-3 px-1 pt-2">
            <span className="text-xs text-muted">{mock ? "演示模式：未配置模型密钥，将使用内置模板" : "⌘/Ctrl + Enter 发送"}</span>
            <button
              type="submit"
              disabled={!prompt.trim() || busy}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "正在创建…" : "开始构建"}
            </button>
          </div>
        </form>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <span className="self-center text-xs text-muted">试试：</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              disabled={busy}
              onClick={() => create(example.prompt)}
              className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-40"
            >
              {example.label}
            </button>
          ))}
        </div>
      </section>

      {projects.length > 0 && (
        <section className="mt-16">
          <h2 className="mb-4 text-sm font-medium text-muted">我的项目</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <li key={project.id} className="group relative rounded-2xl border border-line bg-panel hover:border-accent">
                <Link href={`/project/${project.id}`} className="block p-4 pr-12">
                  <div className="truncate font-medium">{project.title}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{Number(project.version_count)} 个版本</span>
                    <time suppressHydrationWarning>{new Date(Number(project.updated_at)).toLocaleString("zh-CN")}</time>
                    {project.published_slug && <span className="text-good">● 已发布</span>}
                  </div>
                </Link>
                <button
                  onClick={() => remove(project.id)}
                  aria-label={`删除 ${project.title}`}
                  className="absolute right-3 top-3 rounded-md px-2 py-1 text-xs text-muted opacity-0 hover:bg-raised hover:text-bad focus:opacity-100 group-hover:opacity-100"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <IntroVideo />

      <footer className="mt-16 text-center text-xs text-muted">
        <Link href="/privacy" className="hover:text-ink">
          隐私政策
        </Link>
      </footer>
    </main>
  );
}
