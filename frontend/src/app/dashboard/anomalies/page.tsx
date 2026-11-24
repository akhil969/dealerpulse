"use client";

import { Suspense, useMemo } from "react";
import { AnomalyCard } from "@/components/AnomalyCard";
import { BranchSelect, useBranchParam } from "@/components/BranchSelect";
import { Empty } from "@/components/ui";
import type { Category } from "@/lib/anomaly/detect";
import { Status, useAnomalies } from "@/lib/anomaly/store";
import { useDashboard } from "@/lib/store";

export default function AnomaliesPage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 400 }} />}>
      <Anomalies />
    </Suspense>
  );
}

const TABS: { id: Status; label: string; empty: string }[] = [
  { id: "flagged", label: "To review", empty: "Nothing waiting for review. New items appear here when the data changes." },
  { id: "confirmed", label: "Confirmed", empty: "Nothing confirmed yet. Items you confirm show up here and on the related branch and person." },
  { id: "dismissed", label: "Dismissed", empty: "Nothing dismissed." },
];
const CATS: { id: "" | Category; label: string }[] = [
  { id: "", label: "All" }, { id: "sales", label: "Sales" }, { id: "team", label: "Team" },
  { id: "delivery", label: "Deliveries" }, { id: "data", label: "Data quality" },
];

function Anomalies() {
  const { user } = useDashboard();
  const { visible, statusOf } = useAnomalies();
  const { branch, params, set } = useBranchParam();
  const tab = (params.get("tab") as Status) || "flagged";
  const cat = (params.get("type") ?? "") as "" | Category;

  const scoped = useMemo(() => visible.filter((a) => (!branch || a.branchId === branch) && (!cat || a.category === cat)), [visible, branch, cat]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, scoped.filter((a) => statusOf(a.id) === t.id).length])), [scoped, statusOf]);
  const shown = scoped.filter((a) => statusOf(a.id) === tab);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Unusual patterns</h1>
          <p>
            DealerPulse checks every month in your file for numbers that are too far from normal to be chance.
            Each one waits here until {user.role === "ceo" ? "you or a branch manager" : "you or leadership"} confirm it&apos;s a real problem or dismiss it.
          </p>
        </div>
        {user.role === "ceo" && <BranchSelect value={branch} onChange={(v) => set("branch", v)} />}
      </div>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="seg" role="tablist" aria-label="Review status">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => set("tab", t.id === "flagged" ? "" : t.id)}>
              {t.label} ({counts[t.id]})
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Type">
          {CATS.map((c) => (
            <button key={c.id} className={cat === c.id ? "on" : ""} aria-pressed={cat === c.id} onClick={() => set("type", c.id)}>{c.label}</button>
          ))}
        </div>
      </div>

      {shown.length ? (
        <div className="anomaly-list">{shown.map((a) => <AnomalyCard key={a.id} a={a} />)}</div>
      ) : (
        <div className="card"><Empty>{TABS.find((t) => t.id === tab)!.empty}</Empty></div>
      )}

      <details className="card card-pad how-it-works">
        <summary><strong>How does this work?</strong></summary>
        <ul>
          <li><strong>Compared with peers.</strong> Each branch and person is compared with everyone else. A gap is only flagged when it&apos;s too big to be bad luck, allowing for how many enquiries they had.</li>
          <li><strong>Compared with their own history.</strong> Monthly enquiries and orders are watched like a car&apos;s dashboard gauges: a sudden jump, a sudden drop, or a slow drift that keeps going.</li>
          <li><strong>Several measures at once.</strong> Someone can look normal on each number but unusual on the combination.</li>
          <li><strong>Data checks.</strong> Records that contradict themselves, such as a status that doesn&apos;t match the history.</li>
          <li><strong>Fewer false alarms.</strong> When many things are tested at once, a few would look unusual by chance. The checks are corrected for that, so what you see here is worth a look.</li>
        </ul>
        <p className="subtle">Checks run on all months in the file, whatever months you picked above. Confirming or dismissing never changes your data.</p>
      </details>
    </div>
  );
}
