"use client";

import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Brand";

const SEEN_KEY = "atoms:intro-seen";

/**
 * The product introduction film. A first-time visitor gets it front and centre; once they close
 * it (or it ends) it tucks away into a small button at the edge of the page, where it stays for
 * every later visit.
 */
export function IntroVideo() {
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      /* storage unavailable: stay tucked away */
    }
    if (seen) return;
    // Mark it as seen the moment it is shown, not when it is closed: a visitor who reloads or
    // navigates away without closing it must not get it again.
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* without storage it cannot be remembered, so do not show it at all */
      return;
    }
    const timer = setTimeout(() => setOpen(true), 500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Browsers only allow autoplay without sound; the viewer turns sound on with one click.
    const el = video.current;
    if (el) {
      el.muted = true;
      el.currentTime = 0;
      void el.play().catch(() => {});
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function close() {
    video.current?.pause();
    setOpen(false);
    setMuted(true);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* preference only */
    }
  }

  function unmute() {
    const el = video.current;
    if (!el) return;
    el.muted = false;
    el.currentTime = 0;
    setMuted(false);
    void el.play().catch(() => {});
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-20 flex items-center gap-2.5 rounded-full border border-line bg-panel py-2 pl-2 pr-4 text-sm font-medium shadow-lg shadow-black/10 transition hover:-translate-y-0.5"
          aria-label="播放 Atoms 介绍视频"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs text-white">▶</span>
          100 秒了解 Atoms
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Atoms 介绍视频"
          onClick={close}
        >
          <div className="intro-pop w-full max-w-5xl overflow-hidden rounded-3xl bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 px-5 py-3">
              <Logo size={22} />
              <span className="text-sm font-semibold">100 秒了解 Atoms</span>
              <span className="hidden text-xs text-muted sm:inline">非官方介绍 · 应聘者自制</span>
              <button onClick={close} className="ml-auto rounded-full bg-raised px-3.5 py-1.5 text-xs font-medium hover:brightness-95">
                跳过，开始使用
              </button>
            </div>
            <div className="relative bg-black">
              <video
                ref={video}
                className="block aspect-video w-full"
                controls
                playsInline
                preload="metadata"
                poster="/intro/atoms-intro-poster.jpg"
                onEnded={close}
                onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
              >
                <source src="/intro/atoms-intro.mp4" type="video/mp4" />
              </video>
              {muted && (
                <button
                  onClick={unmute}
                  className="absolute left-1/2 top-5 -translate-x-1/2 rounded-full bg-white/95 px-5 py-2.5 text-sm font-semibold text-ink shadow-lg hover:bg-white"
                >
                  🔊 打开声音，从头播放
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
