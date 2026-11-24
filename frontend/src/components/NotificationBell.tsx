"use client";

import { useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, apiEnabled } from "@/lib/api";
import { useAnomalies } from "@/lib/anomaly/store";
import { Notice, noticesFor } from "@/lib/notifications";
import { useDashboard } from "@/lib/store";
import { userKey } from "@/lib/user";
import { useDismiss } from "./ui";

const DAY = 86_400_000;

export function ago(asOf: number, at: number) {
  const d = Math.floor((asOf - at) / DAY);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`;
}

interface NoticeCtx {
  items: Notice[];
  read: Set<string>;
  unread: number;
  markRead: (ids: string[]) => void;
}

const Ctx = createContext<NoticeCtx | null>(null);

/** One source of notifications and read state, shared by the bell and the pop-up toasts. */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const { model, user } = useDashboard();
  const key = userKey(user);
  const storageKey = `dealerpulse:read:${key}`;
  const anomalies = useAnomalies();

  const local = useMemo(() => {
    const extra: Notice[] = [];
    const pending = anomalies.visible.filter((a) => anomalies.statusOf(a.id) === "flagged" && anomalies.canReview(a));
    if (pending.length) {
      extra.push({
        // id changes when the set changes, so new flags show as unread again
        id: `anomaly-review:${pending.map((a) => a.id).join("|")}`, severity: "warning", at: model.asOf,
        title: `${pending.length} unusual pattern${pending.length > 1 ? "s" : ""} waiting for your review`,
        body: "Numbers that are too far from normal to be chance. Confirm the real problems and dismiss the rest.",
        href: "/dashboard/anomalies",
      });
    }
    const scope = user.role === "rep" ? { repId: user.repId } : user.role === "manager" ? { branchId: user.branchId } : null;
    if (scope) {
      for (const a of anomalies.confirmedFor(scope)) {
        const r = anomalies.reviews[a.id];
        extra.push({
          id: `anomaly-confirmed:${a.id}`, severity: "critical", at: model.asOf,
          title: `Confirmed: ${a.title}`,
          body: `${r?.by ?? "A reviewer"} confirmed this is a real problem.${r?.note ? ` “${r.note}”` : ""}`,
          href: a.href ?? "/dashboard/anomalies?tab=confirmed",
        });
      }
    }
    return [...extra, ...noticesFor(model, user)];
  }, [model, user, anomalies]);

  const [remote, setRemote] = useState<Notice[] | null>(null);
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (apiEnabled) return;
    try {
      setRead(new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]")));
    } catch {
      setRead(new Set());
    }
  }, [storageKey]);

  // API mode: load the list, then keep it live with the server-sent event stream.
  useEffect(() => {
    if (!apiEnabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    api.notifications().then((r) => {
      setRemote(r.items);
      setRead(new Set(r.items.filter((n) => n.read).map((n) => n.id)));
    }).catch(() => setRemote([]));

    const connect = async () => {
      if (stopped) return;
      try {
        // EventSource can't send headers, so it signs in with a short-lived stream ticket.
        const { ticket } = await api.streamTicket();
        es = new EventSource(api.streamUrl(ticket));
        es.addEventListener("notice", (e) => {
          const n = JSON.parse((e as MessageEvent).data) as Notice;
          setRemote((xs) => (xs && xs.some((x) => x.id === n.id) ? xs : [n, ...(xs ?? [])]));
        });
        // The server ends the stream after a while (and the ticket expires), so reconnect with a fresh ticket.
        const again = () => { es?.close(); if (!stopped) retry = setTimeout(connect, 3000); };
        es.addEventListener("bye", again);
        es.onerror = again;
      } catch {
        retry = setTimeout(connect, 10_000);
      }
    };
    connect();
    return () => { stopped = true; es?.close(); clearTimeout(retry); };
  }, [key]);

  const markRead = useCallback((ids: string[]) => {
    setRead((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      if (!apiEnabled) localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
    if (apiEnabled) api.markRead(ids).catch(() => {});
  }, [storageKey]);

  const items = apiEnabled ? remote ?? [] : local;
  const value = useMemo(() => ({ items, read, unread: items.filter((n) => !read.has(n.id)).length, markRead }), [items, read, markRead]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotices() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotices must be used inside NoticeProvider");
  return ctx;
}

export function NotificationBell() {
  const { model } = useDashboard();
  const { items, read, unread, markRead } = useNotices();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div className="popover-wrap" ref={ref} data-tour="bell">
      <button
        className="icon-btn"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="popover notif" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <div>
              <h2>Needs your attention</h2>
              <p className="subtle">{unread ? `${unread} new` : "All caught up"}</p>
            </div>
            {unread > 0 && (
              <button className="link-btn" onClick={() => markRead(items.map((n) => n.id))}>Mark all as read</button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="notif-empty">
              Nothing needs you right now. You&apos;ll see an alert here when a lead goes quiet, an order is delayed or a target slips.
            </p>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    className={`notif-item sev-${n.severity}${read.has(n.id) ? "" : " unread"}`}
                    onClick={() => {
                      markRead([n.id]);
                      setOpen(false);
                      router.push(n.href);
                    }}
                  >
                    <span className="notif-dot" aria-hidden="true" />
                    <span>
                      <span className="notif-title">{n.title}</span>
                      <span className="notif-body">{n.body}</span>
                      <span className="notif-time">{ago(model.asOf, n.at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
