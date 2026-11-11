"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IntroVideo } from "@/components/IntroVideo";
import { MascotRow } from "@/components/Mascot";
import {
  defaultRaceModels,
  ModelControls,
  nextRaceModels,
  RaceLanePicker,
  savedModel,
  type ModelChoice,
  type ModelOption,
} from "@/components/ModelControls";
import { ProjectList, type ProjectCard } from "@/components/ProjectList";

const EXAMPLES = [
  { label: "番茄钟", prompt: "做一个番茄钟应用：25 分钟专注 / 5 分钟休息，可以开始、暂停、重置，记录今天完成了几个番茄，并用环形进度条显示剩余时间。" },
  { label: "记账本", prompt: "做一个个人记账本：可以添加收入和支出（金额、分类、备注），按月查看汇总，用柱状图展示各分类支出占比，数据保存在本地。" },
  { label: "看板", prompt: "做一个三列任务看板（待办 / 进行中 / 已完成），支持新增卡片、拖拽移动卡片、删除卡片，数据保存在本地。" },
  { label: "记忆翻牌", prompt: "做一个记忆翻牌小游戏：4x4 的 emoji 卡片，翻开两张相同则消除，显示步数与用时，通关后可以重新开始。" },
];

export const PENDING_KEY = (id: string) => `atoms:pending:${id}`;

export function Home({
  projects,
  maxProjects,
  isGuest,
  mock,
  models,
  raceMax,
  credits,
  freeLeft,
}: {
  projects: ProjectCard[];
  maxProjects: number;
  isGuest: boolean;
  mock: boolean;
  /** Models the server allows; the first one is the default. */
  models: ModelOption[];
  /** Most models that can race at once; 0 turns race mode off. */
  raceMax: number;
  credits: number;
  /** Free generations left today. */
  freeLeft: number;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [raceOn, setRaceOn] = useState(false);
  const [raceModels, setRaceModels] = useState<string[]>([]);
  const pickable = models.length > 1 && !mock;
  const racing = pickable && raceOn;
  const raceBlocked = racing && (raceModels.length < 2 || raceModels.length > freeLeft + credits);

  // Restore the model picked last time, if the server still offers it.
  useEffect(() => {
    const saved = savedModel(models, credits);
    if (saved) setTimeout(() => setModel(saved), 0);
  }, [models, credits]);

  function toggleRace() {
    if (!raceOn && raceModels.length < 2) setRaceModels(defaultRaceModels(models, credits));
    setRaceOn((on) => !on);
  }

  async function create(text: string) {
    const value = text.trim();
    if (!value || busy || raceBlocked) return;
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
      // The workspace picks this up and starts the first generation immediately, with the model
      // (or the racing models) chosen here.
      const choice: ModelChoice | undefined = racing ? { models: raceModels } : pickable ? { model } : undefined;
      sessionStorage.setItem(PENDING_KEY(data.id), JSON.stringify({ prompt: value, choice }));
      router.push(`/project/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
      setBusy(false);
    }
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
            {pickable ? (
              <ModelControls
                models={models}
                credits={credits}
                raceMax={raceMax}
                raceOn={raceOn}
                onToggleRace={toggleRace}
                model={model}
                onModel={setModel}
              />
            ) : (
              <span className="text-xs text-muted">{mock ? "演示模式：未配置模型密钥，将使用内置模板" : "⌘/Ctrl + Enter 发送"}</span>
            )}
            <button
              type="submit"
              disabled={!prompt.trim() || busy || raceBlocked}
              className="shrink-0 rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "正在创建…" : racing ? "开始竞速" : "开始构建"}
            </button>
          </div>
          {racing && (
            <RaceLanePicker
              models={models}
              credits={credits}
              raceMax={raceMax}
              raceModels={raceModels}
              unitsLeft={freeLeft + credits}
              onToggle={(id) => setRaceModels((list) => nextRaceModels(list, id, raceMax))}
            />
          )}
        </form>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <span className="self-center text-xs text-muted">试试：</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              disabled={busy || raceBlocked}
              title={racing ? "用竞速模式构建这个例子" : undefined}
              onClick={() => create(example.prompt)}
              className="rounded-full border border-line bg-panel px-3.5 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-40"
            >
              {example.label}
            </button>
          ))}
        </div>
      </section>

      <ProjectList projects={projects} maxProjects={maxProjects} isGuest={isGuest} />
      <IntroVideo />

      <footer className="mt-16 text-center text-xs text-muted">
        <Link href="/privacy" className="hover:text-ink">
          隐私政策
        </Link>
      </footer>
    </main>
  );
}
