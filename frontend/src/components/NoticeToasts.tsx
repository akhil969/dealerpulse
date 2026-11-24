"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Notice } from "@/lib/notifications";
import { useNotices } from "./NotificationBell";

// Toasts shown per visit (fewer on short screens); the rest stay in the bell.
const maxToasts = () => (typeof window !== "undefined" && window.innerHeight < 820 ? 3 : 4);
const STAGGER = 900;    // ms between toasts appearing
const LIFETIME = 8000;  // ms each toast stays, paused while hovered or focused

/** Pops unread notifications in one at a time when `start` turns true (after the tour). */
export function NoticeToasts({ start }: { start: boolean }) {
  const { items, read, markRead } = useNotices();
  const router = useRouter();
  const [shown, setShown] = useState<Notice[]>([]);
  const [extra, setExtra] = useState(0);
  const queued = useRef(false);

  useEffect(() => {
    if (!start || queued.current) return;
    queued.current = true;
    const unread = items.filter((n) => !read.has(n.id));
    const MAX = maxToasts();
    const batch = unread.slice(0, MAX);
    const timers = batch.map((n, i) => setTimeout(() => setShown((s) => [...s, n]), 300 + i * STAGGER));
    if (unread.length > MAX) timers.push(setTimeout(() => setExtra(unread.length - MAX), 300 + batch.length * STAGGER));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const remove = (id: string) => setShown((s) => s.filter((n) => n.id !== id));

  if (!shown.length && !extra) return null;
  return (
    <div className="toasts" role="region" aria-label="New notifications" aria-live="polite">
      {shown.map((n) => (
        <Toast key={n.id} n={n} onClose={() => remove(n.id)}
          onOpen={() => { markRead([n.id]); remove(n.id); router.push(n.href); }} />
      ))}
      {extra > 0 && (
        <div className="toast toast-more">
          <span>+{extra} more in your notifications</span>
          <button className="link-btn" onClick={() => setExtra(0)}>OK</button>
        </div>
      )}
    </div>
  );
}

function Toast({ n, onClose, onOpen }: { n: Notice; onClose: () => void; onOpen: () => void }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(LIFETIME);
  const started = useRef(0);

  useEffect(() => {
    if (paused || leaving) return;
    started.current = Date.now();
    const t = setTimeout(() => setLeaving(true), left.current);
    return () => {
      clearTimeout(t);
      left.current -= Date.now() - started.current;
    };
  }, [paused, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onClose, 250); // let the exit animation play
    return () => clearTimeout(t);
  }, [leaving, onClose]);

  return (
    <div
      className={`toast sev-${n.severity}${leaving ? " leaving" : ""}`}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    >
      <span className="toast-rail" aria-hidden="true" />
      <div className="toast-body">
        <strong>{n.title}</strong>
        <span>{n.body}</span>
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <button className="btn btn-sm btn-primary" onClick={onOpen}>View</button>
          <button className="btn btn-sm" onClick={() => setLeaving(true)}>Later</button>
        </div>
      </div>
      <button className="toast-x" aria-label="Close" onClick={() => setLeaving(true)}>×</button>
      <span className="toast-timer" style={{ animationDuration: `${LIFETIME}ms`, animationPlayState: paused ? "paused" : "running" }} aria-hidden="true" />
    </div>
  );
}
