"use client";

import { useEffect, useRef, useState } from "react";
import { buildSrcdoc, buildStreamDoc } from "@/lib/html";

const MAX_STORE_BYTES = 500_000;
const SAVE_DELAY = 600;

type Store = Record<string, string>;

const localKey = (appId: string) => `atoms:app-store:${appId}`;

function readLocal(appId: string): Store {
  try {
    return JSON.parse(localStorage.getItem(localKey(appId)) || "{}");
  } catch {
    return {};
  }
}

/** Resolves to whether the server accepted the save. */
function saveRemote(appId: string, data: Store) {
  // keepalive lets the last save finish even if the page is being closed.
  return fetch(`/api/apps/${appId}/storage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    keepalive: true,
  })
    .then((res) => res.ok)
    .catch(() => false);
}

/**
 * The app's data lives on the server, one copy per (app, user), so it follows the account across
 * devices. A visitor with no identity yet (someone who just opened a shared link) starts from
 * this browser's copy; their first save creates a guest identity and moves the data to the cloud.
 * `remote` stays true until the server actually refuses a save.
 */
async function loadStore(appId: string): Promise<{ data: Store; remote: boolean }> {
  const local = readLocal(appId);
  try {
    const res = await fetch(`/api/apps/${appId}/storage`);
    if (res.status === 401) return { data: local, remote: true };
    if (!res.ok) return { data: local, remote: false };
    const { data } = (await res.json()) as { data: Store };
    if (Object.keys(data).length === 0 && Object.keys(local).length > 0) {
      // First visit since server storage existed: carry over what this browser already had.
      void saveRemote(appId, local);
      return { data: local, remote: true };
    }
    return { data, remote: true };
  } catch {
    return { data: local, remote: false };
  }
}

type FrameState = {
  frame: HTMLIFrameElement | null;
  /** static: loaded from a full document. stream: being fed chunks. final: a stream that was closed. */
  mode: "none" | "static" | "stream" | "final";
  /** The HTML this frame is showing (or should show once queued chunks are delivered). */
  target: string;
  sent: number;
  ready: boolean;
  ending: boolean;
  reloadKey: number;
};

function flush(s: FrameState) {
  const win = s.frame?.contentWindow;
  if (!s.ready || !win) return;
  if (s.sent < s.target.length) {
    win.postMessage({ source: "atoms-host", type: "chunk", text: s.target.slice(s.sent) }, "*");
    s.sent = s.target.length;
  }
  if (s.ending) {
    win.postMessage({ source: "atoms-host", type: "end" }, "*");
    s.ending = false;
  }
}

/**
 * Renders generated HTML in a sandboxed iframe (scripts allowed, but no access to this site's
 * origin, cookies or storage). The app's localStorage is bridged to the host page, which persists
 * it per user on the server (see loadStore).
 *
 * While `streaming` is true and `html` only grows, new text is appended to the live document
 * instead of reloading the frame, so the preview builds up without flashing. When streaming ends
 * on the same text, the document is simply closed and kept.
 *
 * The iframe is managed imperatively: every full load gets a brand-new element.
 */
export default function PreviewFrame({
  html,
  appId,
  reloadKey = 0,
  streaming = false,
  ephemeral = false,
  onError,
}: {
  html: string;
  /** Project id; app data is stored under (appId, current user). */
  appId: string;
  reloadKey?: number;
  streaming?: boolean;
  /** A throwaway preview (e.g. a race entry): starts from the saved data but never writes it. */
  ephemeral?: boolean;
  onError?: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<FrameState>({
    frame: null,
    mode: "none",
    target: "",
    sent: 0,
    ready: false,
    ending: false,
    reloadKey,
  });
  // null until the stored data has been fetched; the frame is not created before that, so the
  // app never boots with empty storage and then overwrites the real data.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const storeRef = useRef<{ data: Store; remote: boolean }>({ data: {}, remote: false });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStore(appId).then((store) => {
      if (cancelled) return;
      storeRef.current = store;
      setLoadedFor(appId);
    });
    return () => {
      cancelled = true;
      // Flush a pending save when the preview goes away.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (storeRef.current.remote) void saveRemote(appId, storeRef.current.data);
      }
    };
  }, [appId]);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    const s = stateRef.current;
    const host = hostRef.current;
    if (!host || loadedFor !== appId) return;

    const forced = s.reloadKey !== reloadKey;
    s.reloadKey = reloadKey;

    if (!forced) {
      if (s.mode === "stream" && html.startsWith(s.target)) {
        s.target = html;
        if (!streaming) {
          s.ending = true;
          s.mode = "final";
        }
        flush(s);
        return;
      }
      // Already showing exactly this document (also covers "waiting for the first new chunk").
      if ((s.mode === "static" || s.mode === "final") && html === s.target) return;
    }

    const frame = document.createElement("iframe");
    frame.title = "应用预览";
    // No allow-same-origin (opaque origin: no cookies, storage or DOM access to this site),
    // no allow-popups and no top navigation. Forms stay enabled because generated apps use them;
    // a form posted at this site's API is rejected by the Origin check in src/proxy.ts.
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.className = "h-full w-full border-0 bg-white";
    const store = storeRef.current.data;
    frame.srcdoc = streaming ? buildStreamDoc(store) : buildSrcdoc(html, store);
    host.replaceChildren(frame);
    Object.assign(s, { frame, mode: streaming ? "stream" : "static", target: html, sent: 0, ready: false, ending: false });
  }, [html, streaming, reloadKey, appId, loadedFor]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const s = stateRef.current;
      if (event.source !== s.frame?.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "atoms-preview") return;
      if (data.type === "ready") {
        s.ready = true;
        flush(s);
      }
      // Untrusted text from the app: bounded here, shown as text, and only sent to the model
      // if the user chooses "fix".
      if (data.type === "error") onErrorRef.current?.(String(data.message).slice(0, 300));
      if (data.type === "storage" && !ephemeral) {
        const next: Store = data.data ?? {};
        const json = JSON.stringify(next);
        if (json.length > MAX_STORE_BYTES) return;
        storeRef.current.data = next;
        try {
          localStorage.setItem(localKey(appId), json);
        } catch {
          /* storage unavailable or full */
        }
        if (storeRef.current.remote) {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            void saveRemote(appId, storeRef.current.data).then((ok) => {
              // Refused (e.g. too many guests from this network): keep the data in this browser.
              if (!ok) storeRef.current.remote = false;
            });
          }, SAVE_DELAY);
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, ephemeral]);

  return <div ref={hostRef} className="h-full w-full" />;
}
