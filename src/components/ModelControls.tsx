"use client";

import Link from "next/link";

/**
 * Model picker and race-mode controls, shared by the home page (first request of a new project)
 * and the workspace (every later request), so both offer exactly the same choices.
 */
export type ModelOption = { id: string; label: string; premium: boolean };

/** What the user chose for one request: a single model, or several racing each other. */
export type ModelChoice = { model?: string; models?: string[] };

const MODEL_KEY = "atoms:model";

export function savedModel(models: ModelOption[], credits: number) {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(MODEL_KEY);
  } catch {
    /* preference only */
  }
  const match = models.find((m) => m.id === saved);
  // A premium model is only restored while there are credits to pay for it.
  return match && (!match.premium || credits > 0) ? match.id : null;
}

/** The model chips shown under the input controls while race mode is on. */
export function RaceLanePicker({
  models,
  credits,
  raceMax,
  raceModels,
  unitsLeft,
  onToggle,
}: {
  models: ModelOption[];
  credits: number;
  raceMax: number;
  raceModels: string[];
  /** Free generations left today plus credits: what a race can be paid from. */
  unitsLeft: number;
  onToggle: (id: string) => void;
}) {
  const short = raceModels.length > unitsLeft;
  // Models that need credits are only listed once the user has some; until then one line says so.
  const usable = models.filter((m) => !m.premium || credits > 0);
  const lockedCount = models.length - usable.length;
  const full = raceModels.length >= raceMax;
  return (
    <div className="mt-2 border-t border-line px-1 pt-2.5 text-left">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="font-medium text-ink">
          选择参赛模型
          <span className="ml-1.5 font-normal text-muted">
            已选 {raceModels.length}，可选 2–{raceMax} 个
          </span>
        </span>
        <span className="text-muted">消耗 {raceModels.length} 次额度</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {usable.map((m) => {
          const on = raceModels.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => onToggle(m.id)}
              title={!on && full ? `最多选 ${raceMax} 个` : m.premium ? "消耗 1 积分" : "使用免费次数"}
              className={`rounded-lg border px-2.5 py-1 text-xs transition disabled:opacity-40 ${
                on
                  ? "border-accent bg-accent-soft font-medium text-accent"
                  : "border-line bg-panel text-ink hover:border-accent"
              }`}
            >
              {on && <span aria-hidden>✓ </span>}
              {m.label}
              {m.premium && <span className="ml-1 font-normal opacity-70">1 积分</span>}
            </button>
          );
        })}
      </div>
      <p className={`mt-2 text-xs ${short ? "text-bad" : "text-muted"}`}>
        {short ? (
          <>
            额度不够：免费次数和积分加起来还剩 {unitsLeft} 次。少选一个模型，或
            <Link href="/billing" className="underline">
              补充积分
            </Link>
            。
          </>
        ) : (
          <>
            几个模型同时构建同一个需求，完成后挑一版保留。
            {lockedCount > 0 && (
              <>
                另有 {lockedCount} 个高级模型，
                <Link href="/billing" className="text-accent hover:underline">
                  有积分后可选
                </Link>
                。
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/** The race toggle and the single-model select that sit under the input. */
export function ModelControls({
  models,
  credits,
  raceMax,
  raceOn,
  onToggleRace,
  model,
  onModel,
}: {
  models: ModelOption[];
  credits: number;
  raceMax: number;
  raceOn: boolean;
  onToggleRace: () => void;
  model: string;
  onModel: (id: string) => void;
}) {
  const selectable = models.filter((m) => !m.premium || credits > 0);
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
      {raceMax >= 2 && (
        <button
          type="button"
          aria-pressed={raceOn}
          onClick={onToggleRace}
          disabled={!raceOn && selectable.length < 2}
          title={selectable.length < 2 ? "竞速需要至少两个可用的模型" : "让多个模型同时构建，挑最好的一版"}
          className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 disabled:opacity-40 ${
            raceOn ? "border-accent bg-accent text-white" : "border-line text-ink hover:bg-raised"
          }`}
        >
          🏁 竞速
        </button>
      )}
      {!raceOn && <span className="shrink-0">模型</span>}
      <select
        hidden={raceOn}
        value={model}
        onChange={(e) => {
          onModel(e.target.value);
          try {
            localStorage.setItem(MODEL_KEY, e.target.value);
          } catch {
            /* preference only */
          }
        }}
        className="min-w-0 max-w-44 rounded-md border border-line bg-bg px-1.5 py-0.5 text-ink outline-none"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id} disabled={m.premium && credits <= 0}>
            {m.label}
            {m.premium ? " · 1 积分" : models.some((x) => x.premium) ? " · 免费" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Race-mode state with the same rules everywhere: at most `raceMax` lanes, two preselected. */
export function nextRaceModels(list: string[], id: string, raceMax: number) {
  return list.includes(id) ? list.filter((m) => m !== id) : list.length < raceMax ? [...list, id] : list;
}

export function defaultRaceModels(models: ModelOption[], credits: number) {
  return models
    .filter((m) => !m.premium || credits > 0)
    .slice(0, 2)
    .map((m) => m.id);
}
