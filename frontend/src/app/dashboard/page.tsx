"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ActivityChart, CompareChart, TargetChart } from "@/components/charts";
import { PulseBand, verdictFor } from "@/components/PulseBand";
import { BranchTable } from "@/components/tables";
import { ConfirmedFindings } from "@/components/ConfirmedFindings";
import { Card, InsightList, Kpi } from "@/components/ui";
import { branchTable, insights, kpis, monthly, rangeLabel } from "@/lib/analytics";
import { HINT } from "@/lib/hints";
import { inr, num, pct } from "@/lib/format";
import { useDashboard } from "@/lib/store";

export default function OverviewPage() {
  const { model, range } = useDashboard();
  const [metric, setMetric] = useState<"units" | "revenue">("units");

  const k = useMemo(() => kpis(model, range), [model, range]);
  const ins = useMemo(() => insights(model, range), [model, range]);
  const series = useMemo(() => monthly(model, range), [model, range]);
  const branches = useMemo(() => branchTable(model, range), [model, range]);
  const attainment = branches.map((b) => ({ name: b.branch.name, value: b.unitAttainment ?? 0 })).sort((a, b) => b.value - a.value);
  const story = ins.find((i) => i.id !== "target-gap" && i.id !== "target-hit");

  return (
    <div className="stack">
      <PulseBand
        eyebrow={`All ${model.branches.length} branches · ${rangeLabel(range)}`}
        verdict={verdictFor(k.unitAttainment)}
        story={story ? <><strong>{story.title}.</strong> {story.detail}</> : "No major issues found in this period."}
        gauge={{ value: k.unitAttainment, display: pct(k.unitAttainment), caption: "of car sales target" }}
        stats={[
          { label: "Cars ordered", value: `${num(k.orders)} of ${num(k.targetUnits)}`, hint: HINT.orders },
          { label: "Order value", value: inr(k.revenue), sub: `target ${inr(k.targetRevenue ?? 0)}`, hint: HINT.revenue },
          { label: "Enquiries", value: num(k.leadsCreated), hint: HINT.leads },
        ]}
        actions={<button className="btn btn-ghost btn-sm no-print" onClick={() => window.print()}>Save as PDF</button>}
      />

      <div className="grid grid-kpi" data-tour="kpis">
        <Kpi label="Enquiries that became orders" value={pct(k.conversion, 1)} sub={`from ${num(k.leadsCreated)} enquiries`} hint={HINT.conversion} />
        <Kpi label="Cars delivered" value={num(k.deliveries)} sub={`${num(k.avgDaysToDeliver, 1)} days on average after ordering`} hint={HINT.deliveries} />
        <Kpi label="Still in progress" value={num(k.openPipelineCount)} sub={`worth ${inr(k.openPipelineValue)}`} hint={HINT.pipeline} />
        <Kpi label="First reply time" value={k.avgFirstContactHours !== null ? `${num(k.avgFirstContactHours)} h` : "—"} sub="from enquiry to first call" hint={HINT.firstContact} />
        <Link href="/dashboard/followups">
          <Kpi label="Needs a follow-up" value={num(k.staleCount + k.stuckOrders)} tone={k.staleCount + k.stuckOrders > 0 ? "bad" : "good"}
            sub={`${k.staleCount} quiet customers · ${k.stuckOrders} late deliveries →`} hint={HINT.followUp} />
        </Link>
      </div>

      <ConfirmedFindings />
      <Card title="What needs attention" subtitle="Most urgent first. Press View to see the customers behind each one." tour="attention">
        <InsightList items={ins} />
      </Card>

      <div className="grid grid-3-1">
        <Card
          title="Orders against target, month by month"
          subtitle="Bars are cars ordered. The dashed line is the target."
          actions={
            <div className="seg no-print" role="group" aria-label="Show">
              <button className={metric === "units" ? "on" : ""} aria-pressed={metric === "units"} onClick={() => setMetric("units")}>Cars</button>
              <button className={metric === "revenue" ? "on" : ""} aria-pressed={metric === "revenue"} onClick={() => setMetric("revenue")}>Value</button>
            </div>
          }
        >
          <TargetChart data={series} metric={metric} />
        </Card>
        <Card title="Each branch's progress" subtitle={`Share of target reached, ${rangeLabel(range)}`}>
          <CompareChart data={attainment} valueLabel="Target reached" fmt={(v) => pct(v)} />
        </Card>
      </div>

      <Card title="Branches" subtitle="Furthest behind first. Select a branch to see its team and customers.">
        <BranchTable rows={branches} />
      </Card>

      <Card title="Enquiries, orders and deliveries each month">
        <ActivityChart data={series} />
      </Card>
    </div>
  );
}
