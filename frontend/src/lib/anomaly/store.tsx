"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, apiEnabled, ServerAnomaly } from "../api";
import { useDashboard, useStore } from "../store";
import type { User } from "../user";
import { Anomaly, detectAnomalies } from "./detect";

export type Decision = "confirmed" | "dismissed";

export interface ReviewEvent {
  decision: Decision | "reopened";
  note: string;
  by: string;
  role: User["role"];
  at: string; // ISO
}

export interface Review {
  decision: Decision;
  note: string;
  by: string;
  role: User["role"];
  at: string;
  history: ReviewEvent[];
  /** The finding as the reviewer saw it, so people with a narrower view still see what was confirmed about them. */
  snapshot?: Anomaly;
}

export type Status = "flagged" | Decision;

interface Ctx {
  all: Anomaly[];
  reviews: Record<string, Review>;
  statusOf: (id: string) => Status;
  /** Anomalies this person may see (leadership: all; manager: their branch; rep: confirmed ones about them). */
  visible: Anomaly[];
  canReview: (a: Anomaly) => boolean;
  review: (id: string, decision: Decision, note: string) => void;
  reopen: (id: string, note: string) => void;
  /** Confirmed anomalies about a branch or rep. Only these are treated as real problems elsewhere in the app. */
  confirmedFor: (scope: { branchId?: string; repId?: string }) => Anomaly[];
  pendingCount: number;
}

const AnomalyCtx = createContext<Ctx | null>(null);

export function canReviewAs(u: User, a: Anomaly): boolean {
  if (u.role === "ceo") return true;
  if (u.role === "manager") return !!a.branchId && a.branchId === u.branchId;
  return false;
}

function LocalAnomalyProvider({ children }: { children: ReactNode }) {
  const { model, user } = useDashboard();
  const { datasetId } = useStore();
  // Detection runs on the role-scoped model, so it never sees rows outside this person's access.
  const all = useMemo(() => detectAnomalies(model), [model]);
  const fp = datasetId ?? "none";
  const key = `dealerpulse:reviews:${fp}`;
  const [reviews, setReviews] = useState<Record<string, Review>>({});

  useEffect(() => {
    try {
      setReviews(JSON.parse(localStorage.getItem(key) ?? "{}"));
    } catch {
      setReviews({});
    }
  }, [key, fp]);

  const persist = useCallback((next: Record<string, Review>, id: string) => {
    setReviews(next);
    localStorage.setItem(key, JSON.stringify(next));
  }, [key, fp]);

  const review = useCallback((id: string, decision: Decision, note: string) => {
    const a = all.find((x) => x.id === id);
    if (!a || !canReviewAs(user, a)) return; // guard: only findings in your own live view, and only in your scope
    const ev: ReviewEvent = { decision, note: note.trim(), by: user.name, role: user.role, at: new Date().toISOString() };
    const prev = reviews[id] ?? reviews[`${id}#log`];
    const next = { ...reviews, [id]: { ...ev, decision, history: [...(prev?.history ?? []), ev], snapshot: a } };
    delete next[`${id}#log`];
    persist(next, id);
  }, [all, user, reviews, persist]);

  const reopen = useCallback((id: string, note: string) => {
    const a = all.find((x) => x.id === id);
    const prev = reviews[id];
    if (!a || !prev || !canReviewAs(user, a)) return;
    const next = { ...reviews };
    delete next[id];
    // Keep the audit trail on a hidden key so reopening doesn't erase who decided what.
    next[`${id}#log`] = { ...prev, history: [...prev.history, { decision: "reopened", note: note.trim(), by: user.name, role: user.role, at: new Date().toISOString() }] };
    persist(next, id);
  }, [all, user, reviews, persist]);

  const value = useMemo<Ctx>(() => {
    const statusOf = (id: string): Status => reviews[id]?.decision ?? "flagged";
    // Live findings plus decided findings this view can't recompute (e.g. a network comparison leadership confirmed).
    const live = new Set(all.map((a) => a.id));
    const decided = Object.entries(reviews)
      .filter(([id, r]) => !id.includes("#") && r.snapshot && !live.has(id))
      .map(([, r]) => r.snapshot!);
    const known = [...all, ...decided];
    const reviewable = (a: Anomaly) => live.has(a.id) && canReviewAs(user, a);
    const visible = known.filter((a) => {
      if (user.role === "ceo") return true;
      if (user.role === "manager") return a.branchId === user.branchId;
      return a.repId === user.repId && statusOf(a.id) === "confirmed";
    });
    return {
      all, reviews, statusOf, visible,
      canReview: reviewable,
      review, reopen,
      confirmedFor: ({ branchId, repId }) => visible.filter((a) => statusOf(a.id) === "confirmed" &&
        (repId ? a.repId === repId : branchId ? a.branchId === branchId : true)),
      pendingCount: visible.filter((a) => statusOf(a.id) === "flagged" && reviewable(a)).length,
    };
  }, [all, reviews, user, review, reopen]);

  return <AnomalyCtx.Provider value={value}>{children}</AnomalyCtx.Provider>;
}

export function useAnomalies() {
  const ctx = useContext(AnomalyCtx);
  if (!ctx) throw new Error("useAnomalies must be used inside AnomalyProvider");
  return ctx;
}


/** API mode: findings, review status and permissions all come from the server. */
function ApiAnomalyProvider({ children }: { children: ReactNode }) {
  const { datasetId } = useStore();
  const [items, setItems] = useState<ServerAnomaly[]>([]);

  const fetchAll = useCallback(() => {
    api.anomalies().then((r) => setItems(r.items)).catch(() => setItems([]));
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll, datasetId]);

  const replace = useCallback((a: ServerAnomaly) => setItems((xs) => xs.map((x) => (x.id === a.id ? a : x))), []);

  const value = useMemo<Ctx>(() => {
    const reviews: Record<string, Review> = {};
    for (const a of items) {
      if (a.review) reviews[a.id] = { ...a.review, role: a.review.role as User["role"], history: [], snapshot: a };
    }
    const statusOf = (id: string): Status => items.find((a) => a.id === id)?.status ?? "flagged";
    const canReview = (a: Anomaly) => !!items.find((x) => x.id === a.id)?.can_review;
    const confirmedFor = ({ branchId, repId }: { branchId?: string; repId?: string }) =>
      items.filter((a) => a.status === "confirmed" && (repId ? a.repId === repId : branchId ? a.branchId === branchId : true));
    return {
      all: items, reviews, statusOf, visible: items, canReview, confirmedFor,
      review: (id, decision, note) => { api.review(id, decision, note).then(replace).catch(fetchAll); },
      reopen: (id, note) => { api.reopen(id, note).then(replace).catch(fetchAll); },
      pendingCount: items.filter((a) => a.status === "flagged" && a.can_review).length,
    };
  }, [items, replace, fetchAll]);

  return <AnomalyCtx.Provider value={value}>{children}</AnomalyCtx.Provider>;
}

export function AnomalyProvider({ children }: { children: ReactNode }) {
  return apiEnabled ? <ApiAnomalyProvider>{children}</ApiAnomalyProvider> : <LocalAnomalyProvider>{children}</LocalAnomalyProvider>;
}