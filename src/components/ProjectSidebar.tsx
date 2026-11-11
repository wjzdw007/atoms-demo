"use client";

import Link from "next/link";
import { useState } from "react";
import type { ProjectCard } from "@/components/ProjectList";

/** One short word for what a project is doing, or nothing when it is simply there. */
function status(project: ProjectCard, current: boolean, busy: boolean) {
  if (current ? busy : project.running) return { text: "生成中", tone: "text-accent", dot: "bg-accent pulse-dot" };
  if (project.racePending) return { text: "待挑选", tone: "text-warn", dot: "bg-warn" };
  if (project.publishedSlug) return { text: "已发布", tone: "text-good", dot: "bg-good" };
  if (project.versionCount === 0 && !current) return { text: "未完成", tone: "text-muted", dot: "bg-line" };
  return null;
}

/**
 * The project list beside the workspace, for moving between projects without going back to the
 * home page. A column on wide screens, a drawer over the page on narrow ones.
 */
export function ProjectSidebar({
  projects,
  currentId,
  currentTitle,
  busy,
  open,
  onClose,
}: {
  projects: ProjectCard[];
  currentId: string;
  /** The open project's title as shown in the top bar; it can be newer than the list. */
  currentTitle: string;
  /** The open project is generating right now. */
  busy: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  if (!open) return null;
  const term = search.trim().toLowerCase();
  const list = projects
    .map((p) => (p.id === currentId ? { ...p, title: currentTitle } : p))
    .filter((p) => !term || p.title.toLowerCase().includes(term) || (p.lastPrompt ?? "").toLowerCase().includes(term));

  return (
    <>
      <button aria-label="关闭项目列表" onClick={onClose} className="fixed inset-0 z-30 bg-black/30 md:hidden" />
      <nav
        aria-label="项目"
        className="fixed inset-y-0 left-0 z-40 flex w-64 max-w-[80vw] flex-col border-r border-line bg-panel md:static md:z-auto md:w-56 md:shrink-0"
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line pl-3 pr-1.5 text-xs">
          <span className="font-medium">
            我的项目 <span className="font-normal text-muted">{projects.length}</span>
          </span>
          <button onClick={onClose} title="收起项目列表" className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink">
            收起
          </button>
        </div>
        <div className="shrink-0 space-y-2 p-2">
          <Link
            href="/"
            className="block rounded-lg border border-dashed border-line px-3 py-1.5 text-center text-xs text-ink hover:border-accent hover:text-accent"
          >
            ＋ 新建项目
          </Link>
          {projects.length > 8 && (
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
              className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-accent"
            />
          )}
        </div>
        <ul className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {list.map((project) => {
            const current = project.id === currentId;
            const state = status(project, current, busy);
            return (
              <li key={project.id}>
                <Link
                  href={`/project/${project.id}`}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    // On a narrow screen the drawer covers the page it just opened.
                    if (window.matchMedia("(max-width: 767px)").matches) onClose();
                  }}
                  className={`block rounded-lg px-2.5 py-1.5 ${current ? "bg-accent-soft" : "hover:bg-raised"}`}
                >
                  <span className={`block truncate text-sm ${current ? "font-medium text-accent" : "text-ink"}`}>{project.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                    {state ? (
                      <>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${state.dot}`} />
                        <span className={state.tone}>{state.text}</span>
                      </>
                    ) : (
                      <span>{project.versionCount > 0 ? `${project.versionCount} 个版本` : "新项目"}</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-2.5 py-3 text-center text-xs text-muted">没有符合的项目</li>}
        </ul>
      </nav>
    </>
  );
}
