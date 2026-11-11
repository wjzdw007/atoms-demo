// Browser-side cache of generated apps' data (see PreviewFrame). No server imports here.

export type Store = Record<string, string>;

/**
 * This browser's copy of an app's data is kept apart per viewer. Keyed by the app alone, the
 * copy written under one account would be shown to whoever used the browser next, and uploaded
 * into their account if it had no data yet.
 */
const LOCAL_PREFIX = "atoms:app-store:";
const VIEWER_KEY = "atoms:viewer";
export const ANONYMOUS = "anon";
export const localKey = (viewer: string, appId: string) => `${LOCAL_PREFIX}${viewer}:${appId}`;

export function readLocal(viewer: string, appId: string): Store {
  try {
    // Copies from before they were kept per viewer cannot be attributed to anyone: drop them.
    localStorage.removeItem(`${LOCAL_PREFIX}${appId}`);
    return JSON.parse(localStorage.getItem(localKey(viewer, appId)) || "{}");
  } catch {
    return {};
  }
}

/** Who this browser was last seen as, for when the server cannot be asked. */
export function lastViewer() {
  try {
    return localStorage.getItem(VIEWER_KEY) || ANONYMOUS;
  } catch {
    return ANONYMOUS;
  }
}

export function rememberViewer(viewer: string) {
  try {
    localStorage.setItem(VIEWER_KEY, viewer);
  } catch {
    /* storage unavailable */
  }
}

/** Called on sign-out: nothing of the account that just left stays readable in this browser. */
export function clearLocalAppData() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(LOCAL_PREFIX) || key === VIEWER_KEY)) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
}
