/**
 * Every tunable of the app in one place. All values come from environment variables (see
 * `.env.example`) and have safe defaults, so the app runs with no configuration at all
 * (in "demo mode", without a model key).
 *
 * Server-only: nothing here may be imported into client components.
 */

function int(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name] as T | undefined;
  return raw && allowed.includes(raw) ? raw : fallback;
}

export type ModelOption = { id: string; label: string; premium: boolean };

function parseModels(raw: string | undefined, fallback: string, free: string[]): ModelOption[] {
  const list = (raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, label] = item.split("=").map((part) => part.trim());
      return { id, label: label || id, premium: free.length > 0 && !free.includes(id) };
    })
    .filter((item) => /^[\w./:-]{1,80}$/.test(item.id));
  if (!list.some((item) => item.id === fallback)) {
    list.unshift({ id: fallback, label: "默认", premium: free.length > 0 && !free.includes(fallback) });
  }
  // Free models, when there are any, are always offered and come first (the first is the default).
  for (const id of [...free].reverse()) {
    const at = list.findIndex((item) => item.id === id);
    list.unshift(at >= 0 ? list.splice(at, 1)[0] : { id, label: id, premium: false });
  }
  return list;
}

export type CreditPack = { id: string; name: string; credits: number; priceCents: number; note: string };

function build() {
  // When set, the daily free allowance only covers these models (comma-separated; the first is the
  // default); every other model costs credits.
  const freeModels = (process.env.LLM_FREE_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
  const model = freeModels[0] || process.env.LLM_MODEL || "glm-5.3";
  const apiKey = process.env.LLM_API_KEY || "";
  return {
    llm: {
      apiKey,
      baseURL: process.env.LLM_BASE_URL || "https://tokenhub.tencentmaas.com/plan/v3",
      /** Writes the app. */
      model,
      freeModels,
      /** Optional fixed models for planning and review; by default they follow the run's model. */
      plannerModel: process.env.LLM_PLANNER_MODEL || "",
      reviewerModel: process.env.LLM_REVIEWER_MODEL || "",
      /**
       * Models whose reasoning is switched off entirely (matched against the model id). DeepSeek
       * on TokenHub ignores a "low" effort and reasons for a minute or more unless told this way.
       */
      noThinking: new RegExp(process.env.LLM_NO_THINKING_MODELS || "deepseek", "i"),
      reasoningEffort: oneOf("LLM_REASONING_EFFORT", ["low", "medium", "high"] as const, "low"),
      /** 0 = no artificial cap: ask for the largest output the model accepts. */
      maxTokens: int("LLM_MAX_TOKENS", 0),
      /**
       * Models a user may pick for the engineer, as "id=label" pairs. The server only ever calls
       * models on this list, so a client cannot make it call an arbitrary (expensive) model.
       */
      models: parseModels(process.env.LLM_MODELS, model, freeModels),
      /**
       * Largest prompt (in characters) sent to the engineer. Context does not grow with chat
       * length (see agents.ts), only with the size of the app itself; past this the user is told
       * to split the app instead of the provider failing with an opaque error.
       */
      maxContextChars: int("LLM_MAX_CONTEXT_CHARS", 400_000),
      /** Without a key the pipeline runs on canned output, so the whole product flow stays testable. */
      mock: !apiKey,
    },
    race: {
      /** Race mode: the same request built by several models side by side; the user keeps one. */
      enabled: process.env.RACE_MODE !== "off",
      maxLanes: Math.min(3, Math.max(2, int("RACE_MAX_LANES", 3))),
    },
    review: {
      /** off: skip review. report: review and show findings. fix: also let the engineer fix them once. */
      mode: oneOf("REVIEW_MODE", ["off", "report", "fix"] as const, "fix"),
    },
    generation: {
      /** Hard stop for one generation job, so a stuck model call cannot run forever. */
      timeoutMs: int("GENERATION_TIMEOUT_SECONDS", 600) * 1000,
      /** How long a finished job's events stay available to late subscribers. */
      retainMs: 60_000,
      /** Jobs one user may run at the same time, and the ceiling for the whole server. */
      maxConcurrentPerUser: int("MAX_CONCURRENT_JOBS_PER_USER", 2),
      maxConcurrent: int("MAX_CONCURRENT_JOBS", 8),
    },
    quota: {
      /** Free generations per day. */
      guestDaily: int("DAILY_FREE_GUEST", 3),
      userDaily: int("DAILY_FREE_USER", 10),
      /**
       * Free generations per day for all guest accounts behind one IP address together. A guest
       * account is only a cookie, so without this a visitor could clear cookies to start over.
       */
      guestDailyPerIp: int("DAILY_FREE_PER_IP", 15),
      /** Most generations one account may run per day, free and paid together. */
      userDailyMax: int("DAILY_MAX_PER_USER", 100),
      /**
       * Site-wide daily ceiling across all users, free or paid: bounds the model bill. Counted in
       * its own table and never decremented by refunds.
       */
      siteDaily: int("SITE_DAILY_GENERATION_LIMIT", 500),
    },
    billing: {
      /**
       * off:    no purchases (default).
       * manual: users place orders; credits arrive only after an administrator confirms payment
       *         through the admin API. Nothing is granted without that confirmation.
       * mock:   orders confirm themselves with no payment at all. For local demos only: it hands
       *         out free credits by design.
       */
      mode: oneOf("BILLING_MODE", ["off", "manual", "mock"] as const, "off"),
      /** Shown to the buyer in manual mode: how to pay and whom to contact. */
      paymentNote: process.env.BILLING_PAYMENT_NOTE || "",
      packs: [
        { id: "starter", name: "入门包", credits: 20, priceCents: 990, note: "适合偶尔使用" },
        { id: "pro", name: "专业包", credits: 100, priceCents: 3900, note: "单次生成更划算" },
        { id: "team", name: "团队包", credits: 400, priceCents: 12900, note: "高频使用" },
      ] satisfies CreditPack[],
      /** Upper bound on credits one account can hold, so the demo checkout cannot be farmed. */
      maxBalance: int("BILLING_MAX_BALANCE", 1000),
    },
    storage: {
      /** Older versions beyond this are pruned (the published version is always kept). */
      maxVersionsPerProject: int("MAX_VERSIONS_PER_PROJECT", 50),
      /** Largest generated document that will be saved. */
      maxHtmlBytes: int("MAX_HTML_BYTES", 800_000),
      /** Per (app, user) key-value storage for generated apps. */
      maxAppDataBytes: int("MAX_APP_DATA_BYTES", 500_000),
      maxProjectsPerUser: int("MAX_PROJECTS_PER_USER", 50),
      /** Total size of all saved versions one account may hold. */
      maxBytesPerUser: int("MAX_STORAGE_BYTES_PER_USER", 50_000_000),
      /** Published apps one account may keep data in. */
      maxAppDataRowsPerUser: int("MAX_APP_DATA_ROWS_PER_USER", 200),
    },
    rateLimit: {
      /** Sign-in attempts per IP per 10 minutes. */
      authPer10Min: int("RATE_LIMIT_AUTH", 20),
      /** New guest accounts per IP per hour. */
      guestsPerHour: int("RATE_LIMIT_GUESTS", 20),
      /** Free, storage-heavy actions (restore a version, remix an app) per user per hour. */
      copiesPerHour: int("RATE_LIMIT_COPIES", 30),
    },
    admin: {
      /** Bearer token for the admin API. Unset = the admin API does not exist. */
      token: process.env.ADMIN_TOKEN || "",
    },
    site: {
      /** Shown on the privacy page as the address for data-deletion requests. */
      contactEmail: process.env.CONTACT_EMAIL || "",
    },
    auth: {
      /** Cookies are HTTPS-only in production unless the site is deliberately served over HTTP. */
      secureCookies: process.env.NODE_ENV === "production" && process.env.ALLOW_HTTP !== "1",
      sessionDays: int("SESSION_DAYS", 30),
    },
  };
}

let cached: ReturnType<typeof build> | null = null;

export function config() {
  return (cached ??= build());
}
