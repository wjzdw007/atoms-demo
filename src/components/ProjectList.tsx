"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type ProjectCard = {
  id: string;
  title: string;
  versionCount: number;
  /** The request behind the newest version. */
  lastPrompt: string | null;
  updatedAt: number;
  publishedSlug: string | null;
  remixed: boolean;
  /** A generation is running on the server right now. */
  running: boolean;
  /** A finished race is waiting for the user to keep one entry. */
  racePending: boolean;
};

type Filter = "all" | "published" | "attention";

function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

/** What state the project is in, in the order a user would care about. */
function describe(project: ProjectCard) {
  if (project.running) return "正在生成，打开可以看实时进度";
  if (project.racePending) return "竞速已完成，等你挑一版保留";
  if (project.versionCount === 0) return "还没有生成出可用的版本，打开后可以重新描述需求";
  return project.lastPrompt || "";
}

export function ProjectList({
  projects: initial,
  maxProjects,
  isGuest,
}: {
  projects: ProjectCard[];
  maxProjects: number;
  isGuest: boolean;
}) {
  const router = useRouter();
  // Deletions and renames show at once; the server list catches up on the next refresh.
  const [removed, setRemoved] = useState<string[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const projects = initial
    .filter((p) => !removed.includes(p.id))
    .map((p) => ({ ...p, title: titles[p.id] ?? p.title }));
  if (projects.length === 0) return null;

  const needsAttention = (p: ProjectCard) => p.running || p.racePending || p.versionCount === 0;
  const counts = {
    all: projects.length,
    published: projects.filter((p) => p.publishedSlug).length,
    attention: projects.filter(needsAttention).length,
  };
  const term = search.trim().toLowerCase();
  const shown = projects.filter(
    (p) =>
      (filter === "all" || (filter === "published" ? Boolean(p.publishedSlug) : needsAttention(p))) &&
      (!term || p.title.toLowerCase().includes(term) || (p.lastPrompt ?? "").toLowerCase().includes(term)),
  );

  async function rename(id: string, value: string) {
    const title = value.trim().slice(0, 40);
    setEditing(null);
    if (!title || title === projects.find((p) => p.id === id)?.title) return;
    setError("");
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    if (!res?.ok) return setError("重命名失败，请稍后再试。");
    setTitles((map) => ({ ...map, [id]: title }));
    router.refresh();
  }

  async function remove(project: ProjectCard) {
    const consequences = [
      project.versionCount ? `${project.versionCount} 个版本` : "",
      project.publishedSlug ? "已发布的分享链接" : "",
      project.running ? "正在进行的生成" : "",
    ].filter(Boolean);
    const detail = consequences.length ? `它的${consequences.join("、")}会一起删除，` : "";
    if (!confirm(`删除「${project.title}」？${detail}无法恢复。`)) return;
    setError("");
    const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) return setError("删除失败，请稍后再试。");
    setRemoved((list) => [...list, project.id]);
    router.refresh();
  }

  async function copyLink(project: ProjectCard) {
    try {
      await navigator.clipboard.writeText(`${location.origin}/s/${project.publishedSlug}`);
      setCopied(project.id);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("复制失败，请打开分享页后从地址栏复制。");
    }
  }

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "published", label: "已发布" },
    { key: "attention", label: "待处理" },
  ];

  return (
    <section className="mt-16" aria-labelledby="projects-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="projects-heading" className="text-lg font-semibold">
            我的项目
            <span className="ml-2 text-sm font-normal text-muted">
              {projects.length} / {maxProjects}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {isGuest ? (
              <>
                你现在是访客，项目只跟着这个浏览器。
                <Link href="/login" className="text-accent hover:underline">
                  登录
                </Link>
                后会原样保留，并能在其他设备上打开。
              </>
            ) : (
              "按最近修改排序。点项目继续修改，每次修改都会存成一个新版本。"
            )}
          </p>
        </div>
        {projects.length > 4 && (
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称或需求"
            aria-label="搜索项目"
            className="w-full rounded-full border border-line bg-panel px-3.5 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent sm:w-56"
          />
        )}
      </div>

      {(counts.published > 0 || counts.attention > 0) && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="筛选项目">
          {tabs
            .filter((tab) => tab.key === "all" || counts[tab.key] > 0)
            .map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={filter === tab.key}
                onClick={() => setFilter(tab.key)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  filter === tab.key ? "border-ink bg-ink text-white" : "border-line bg-panel text-ink hover:border-accent"
                }`}
              >
                {tab.label} {counts[tab.key]}
              </button>
            ))}
        </div>
      )}
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}

      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-panel/60 p-6 text-center text-sm text-muted">
          没有符合条件的项目。
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {shown.map((project) => (
            <li key={project.id} className="flex flex-col rounded-2xl border border-line bg-panel text-left hover:border-accent">
              {editing?.id === project.id ? (
                <form
                  className="p-4 pb-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(project.id, editing.value);
                  }}
                >
                  <label className="text-xs text-muted" htmlFor={`rename-${project.id}`}>
                    项目名称（回车保存，Esc 取消）
                  </label>
                  <input
                    id={`rename-${project.id}`}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    value={editing.value}
                    maxLength={40}
                    onChange={(e) => setEditing({ id: project.id, value: e.target.value })}
                    onBlur={() => void rename(project.id, editing.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-accent bg-bg px-2.5 py-1.5 font-medium outline-none"
                  />
                </form>
              ) : (
                <Link href={`/project/${project.id}`} className="block flex-1 rounded-t-2xl p-4 pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate font-medium">{project.title}</span>
                    <span className="flex shrink-0 gap-1">
                      {project.running && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">● 生成中</span>
                      )}
                      {project.racePending && (
                        <span className="rounded-full bg-[#fff1d6] px-2 py-0.5 text-xs text-warn">🏁 待挑选</span>
                      )}
                      {project.publishedSlug && (
                        <span className="rounded-full bg-[#dcf5e6] px-2 py-0.5 text-xs text-good">已发布</span>
                      )}
                      {!project.running && !project.racePending && project.versionCount === 0 && (
                        <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">未完成</span>
                      )}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 min-h-10 text-sm text-muted">{describe(project)}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {project.versionCount > 0 && <span>共 {project.versionCount} 个版本</span>}
                    <time suppressHydrationWarning title={new Date(project.updatedAt).toLocaleString("zh-CN")}>
                      {ago(project.updatedAt)}修改
                    </time>
                    {project.remixed && <span>Remix 来的</span>}
                  </div>
                </Link>
              )}
              <div className="flex flex-wrap items-center gap-x-1 border-t border-line px-2.5 py-1.5 text-xs">
                <Link href={`/project/${project.id}`} className="rounded-md px-2 py-1 font-medium text-accent hover:bg-accent-soft">
                  打开
                </Link>
                <button
                  onClick={() => setEditing({ id: project.id, value: project.title })}
                  className="rounded-md px-2 py-1 text-ink hover:bg-raised"
                >
                  重命名
                </button>
                {project.publishedSlug && (
                  <>
                    <a
                      href={`/s/${project.publishedSlug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md px-2 py-1 text-ink hover:bg-raised"
                    >
                      分享页 ↗
                    </a>
                    <button onClick={() => void copyLink(project)} className="rounded-md px-2 py-1 text-ink hover:bg-raised">
                      {copied === project.id ? "已复制" : "复制链接"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => void remove(project)}
                  aria-label={`删除 ${project.title}`}
                  className="ml-auto rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-bad"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
