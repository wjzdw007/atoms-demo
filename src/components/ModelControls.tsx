"use client";

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

/** The lane chips shown above the input while race mode is on. */
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
  return (
    <div className="mb-2 rounded-xl bg-accent-soft p-2 text-left">
      <div className="mb-1.5 text-xs">
        🏁 竞速模式：选 2–{raceMax} 个模型同时构建，完成后挑一版保留。本次消耗 {raceModels.length} 次额度。
        {short && (
          <span className="mt-1 block text-bad">
            额度不够：今天的免费次数和积分加起来还剩 {unitsLeft} 次。可以少选模型、关掉竞速，或到「额度」页补充积分。
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {models.map((m) => {
          const on = raceModels.includes(m.id);
          const locked = m.premium && credits <= 0;
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              disabled={locked || (!on && raceModels.length >= raceMax)}
              onClick={() => onToggle(m.id)}
              title={locked ? "需要积分" : m.premium ? "消耗 1 积分" : "使用免费次数"}
              className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-40 ${
                on ? "border-accent bg-accent text-white" : "border-line bg-panel text-ink"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
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
