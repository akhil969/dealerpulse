"use client";

import { Suspense, useMemo, useState } from "react";
import { BranchSelect, useBranchParam } from "@/components/BranchSelect";
import { FunnelChart, ReasonChart, SegmentChart } from "@/components/charts";
import { Card, Column, DataTable, Kpi } from "@/components/ui";
import { bySource, byModel, funnel, FunnelStep, kpis, lostReasons, rangeLabel, SegmentRow } from "@/lib/analytics";
import { inr, num, pct, STATUS_LABEL, titleCase } from "@/lib/format";
import { useDashboard } from "@/lib/store";

export default function FunnelPage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 400 }} />}>
      <Funnel />
    </Suspense>
  );
}

function Funnel() {
  const { model, range, user } = useDashboard();
  const { branch, set } = useBranchParam();
  const scope = useMemo(() => (branch ? { branchId: branch } : {}), [branch]);

  const steps = useMemo(() => funnel(model, range, scope), [model, range, scope]);
  const reasons = useMemo(() => lostReasons(model, range, scope), [model, range, scope]);
  const sources = useMemo(() => bySource(model, range, scope), [model, range, scope]);
  const models = useMemo(() => byModel(model, range, scope), [model, range, scope]);
  const k = useMemo(() => kpis(model, range, scope), [model, range, scope]);
  const recorded = reasons.filter((r) => r.name !== "Not recorded");
  const unrecorded = reasons.find((r) => r.name === "Not recorded")?.value ?? 0;
  const lostTotal = reasons.reduce((a, r) => a + r.value, 0);

  const stepCols: Column<FunnelStep>[] = [
    { key: "stage", label: "Stage", render: (s) => <span className="cell-strong">{STATUS_LABEL[s.stage]}</span> },
    { key: "count", label: "People", num: true, render: (s) => num(s.count) },
    { key: "of", label: "Of all enquiries", num: true, render: (s) => pct(s.overallRate) },
    { key: "step", label: "Carried on from step before", num: true, render: (s) => s.stepRate === null ? "—" : (
      <span className={s.stepRate < 0.6 ? "tone-bad cell-strong" : ""}>{pct(s.stepRate)}</span>
    ) },
    { key: "lost", label: "Dropped out here", num: true, render: (s) => num(s.lostHere) },
  ];
  const segCols = (label: string): Column<SegmentRow>[] => [
    { key: "name", label, sort: (r) => r.name, render: (r) => <span className="cell-strong">{titleCase(r.name)}</span> },
    { key: "leads", label: "Leads", num: true, sort: (r) => r.leads, render: (r) => num(r.leads) },
    { key: "orders", label: "Orders", num: true, sort: (r) => r.orders, render: (r) => num(r.orders) },
    { key: "conv", label: "Conversion", num: true, sort: (r) => r.conversion ?? -1, render: (r) => pct(r.conversion, 1) },
    { key: "rev", label: "Revenue", num: true, sort: (r) => r.revenue, render: (r) => inr(r.revenue) },
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Sales funnel</h1>
          <p>How customers move from first enquiry to delivery, and where they drop out. Covers enquiries from {rangeLabel(range)}.</p>
        </div>
        {user.role === "ceo" && <BranchSelect value={branch} onChange={(v) => set("branch", v)} />}
      </div>

      <div className="grid grid-2">
        <Card title="How far customers got" subtitle="Each bar counts the people who reached that step">
          <FunnelChart steps={steps} />
        </Card>
        <Card title="Step by step" subtitle="Red marks a step where fewer than 60% carry on">
          <DataTable rows={steps} columns={stepCols} rowKey={(s) => s.stage} />
        </Card>
      </div>

      <WhatIf steps={steps} avgDeal={k.avgDealValue} />

      <Card
        title="Why customers didn't buy"
        subtitle={lostTotal ? `${num(lostTotal)} customers didn't buy${unrecorded ? `, ${pct(unrecorded / lostTotal)} have no reason written down` : ""}` : undefined}
      >
        <ReasonChart data={recorded} />
        {unrecorded > 0 && (
          <p className="subtle" style={{ marginTop: 8 }}>
            {num(unrecorded)} lost customers have no reason written down. Asking the team to always pick a reason would make this chart more reliable.
          </p>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Where enquiries come from" subtitle="Bars show how many came in. The line shows how many became orders.">
          <SegmentChart data={sources} />
          <DataTable rows={sources} columns={segCols("Source")} rowKey={(r) => r.name} initialSort={{ key: "conv", dir: "desc" }} />
        </Card>
        <Card title="Which cars people ask about" subtitle="Bars show how many came in. The line shows how many became orders.">
          <SegmentChart data={models} />
          <DataTable rows={models} columns={segCols("Model")} rowKey={(r) => r.name} initialSort={{ key: "rev", dir: "desc" }} />
        </Card>
      </div>
    </div>
  );
}

const TRANSITIONS = [
  { from: 1, label: "Contacted → Test drive" },
  { from: 2, label: "Test drive → Negotiation" },
  { from: 3, label: "Negotiation → Order" },
];

function WhatIf({ steps, avgDeal }: { steps: FunnelStep[]; avgDeal: number | null }) {
  const [t, setT] = useState(2);
  const [uplift, setUplift] = useState(10);
  // Leads at stage `t`, then current pass-through from `t` to order.
  const atStage = steps[t]?.count ?? 0;
  const orders = steps[4]?.count ?? 0;
  const next = steps[t + 1]?.count ?? 0;
  const stepRate = atStage ? next / atStage : 0;
  const downstream = next ? orders / next : 0;
  const newStep = Math.min(1, stepRate * (1 + uplift / 100));
  const extraOrders = Math.max(0, Math.round(atStage * (newStep - stepRate) * downstream));
  const extraRevenue = extraOrders * (avgDeal ?? 0);

  return (
    <Card title="What if we got better at one step?" subtitle="Move the slider to see the extra sales">
      <div className="grid grid-2" style={{ alignItems: "center" }}>
        <div className="stack" style={{ gap: 12 }}>
          <label className="row">
            <span className="muted" style={{ width: 90 }}>Improve</span>
            <select value={t} onChange={(e) => setT(Number(e.target.value))}>
              {TRANSITIONS.map((x) => <option key={x.from} value={x.from}>{x.label}</option>)}
            </select>
          </label>
          <label className="row">
            <span className="muted" style={{ width: 90 }}>by</span>
            <input type="range" min={5} max={50} step={5} value={uplift} onChange={(e) => setUplift(Number(e.target.value))} style={{ flex: 1, minWidth: 120 }} />
            <strong style={{ width: 48 }}>{uplift}%</strong>
          </label>
          <p className="subtle">
            Today {pct(stepRate)} of customers make this step. A {uplift}% relative improvement lifts it to {pct(newStep)}.
            Later stages are assumed to convert at today&apos;s rates.
          </p>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Kpi label="Extra cars sold" value={`+${num(extraOrders)}`} tone="good" sub={`on ${num(orders)} today`} />
          <Kpi label="Extra order value" value={`+${inr(extraRevenue)}`} tone="good" sub={`at ${inr(avgDeal ?? 0)} avg deal`} />
        </div>
      </div>
    </Card>
  );
}
