export type User = {
  id: string;
  email: string | null;
  name: string;
  is_guest: number;
};

export type Project = {
  id: string;
  user_id: string;
  title: string;
  published_slug: string | null;
  published_version_id: string | null;
  remixed_from: string | null;
  created_at: number;
  updated_at: number;
};

export type VersionMeta = {
  id: string;
  number: number;
  prompt: string;
  created_at: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  version_id: string | null;
  created_at: number;
};

export type AgentName = "planner" | "engineer" | "reviewer" | "qa";

/** Events of one generation job, streamed (as NDJSON) to the workspace and replayable on reconnect. */
export type AgentEvent =
  /** `lane` is set in race mode, where several engineers write at the same time. */
  | { type: "stage"; agent: AgentName; status: "start" | "done"; note?: string; lane?: number; failed?: boolean }
  /** The model's reasoning before (or between) its output. Shown while it runs, never saved. */
  | { type: "thinking"; agent: AgentName; delta: string; lane?: number }
  | { type: "plan"; delta: string }
  | { type: "code"; delta: string; lane?: number }
  | { type: "race_start"; lanes: { model: string; label: string }[] }
  | { type: "race_done"; candidates: RaceCandidate[]; message: Message }
  /** The engineer is rewriting after review: discard the code received so far. */
  | { type: "code_reset" }
  | { type: "review"; delta: string }
  | { type: "done"; version: VersionMeta; message: Message; title: string }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export type JobSnapshot = { running: boolean; prompt: string; startedAt: number } | null;

/** One finished entry of a race, waiting for the user to keep it or not. */
export type RaceCandidate = {
  id: string;
  lane: number;
  model: string;
  label: string;
  seconds: number;
  /** Empty when the lane failed. */
  html: string;
  error?: string;
};
