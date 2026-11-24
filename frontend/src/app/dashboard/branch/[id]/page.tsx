"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { CompareChart, FunnelChart, TargetChart } from "@/components/charts";
import { PulseBand, verdictFor } from "@/components/PulseBand";
import { LeadTable, RepTable } from "@/components/tables";
import { ConfirmedFindings } from "@/components/ConfirmedFindings";
import { Card, Crumbs, Empty, InsightList, Kpi } from "@/components/ui";
import { funnel, insights, kpis, monthly, rangeLabel, repTable, staleLeads } from "@/lib/analytics";
import { inr, num, pct } from "@/lib/format";
import { HINT } from "@/lib/hints";
import { seesBenchmarks } from "@/lib/access";
import { useDashboard } from "@/lib/store";
import { homeFor } from "@/lib/user";

export default function BranchPage() {
  const { id } = useParams<{ id: string }>();
  const { model, range, user } = useDashboard();
  const branch = model.branchById.get(id);
  const [metric, setMetric] = useState<"units" | "revenue">("units");
  const scope = useMemo(() => ({ branchId: id }), [id]);

  const k = useMemo(() => kpis(model, range, scope), [model, range, scope]);
  const network = useMemo(() => kpis(model, range), [model, range]);
  const ins = useMemo(() => insights(model, range, scope), [model, range, scope]);
  const series = useMemo(() => monthly(model, range, scope), [model, range, scope]);
  const reps = useMemo(() => repTable(model, range, id), [model, range, id]);
  const steps = useMemo(() => funnel(model, range, scope), [model, range, scope]);
  const stale = useMemo(() => staleLeads(model, scope), [model, scope]);

  if (!branch) {
    return <Empty>We couldn&apos;t find branch “{id}” in this data. <Link href={homeFor(user)} className="cell-link">Back to my dashboard</Link></Empty>;
  }
  const manager = model.reps.find((r) => r.branch_id === id && r.role === "branch_manager");
  const mine = user.branchId === id;
  const story = ins.find((i) => i.id !== "target-gap" && i.id !== "target-hit");
  const vsNetwork = seesBenchmarks(user.role) && k.conversion !== null && network.conversion !== null
    ? `${pct(k.conversion)} of enquiries become orders here, against ${pct(network.conversion)} across all branches.`
    : "";

  return (
    <div className="stack">
      {user.role === "ceo" && <Crumbs items={[{ label: "All branches", href: "/dashboard" }, { label: branch.name }]} />}
      <PulseBand
        eyebrow={`${mine ? "Your branch" : "Branch"} · ${branch.city} · ${rangeLabel(range)}`}
        verdict={`${branch.name}: ${verdictFor(k.unitAttainment).toLowerCase()}`}
        story={<>{vsNetwork} {story ? <><strong>{story.title}.</strong> {story.detail}</> : null}</>}
        gauge={{ value: k.unitAttainment, display: pct(k.unitAttainment), caption: "of car sales target" }}
        stats={[
          { label: "Cars ordered", value: `${num(k.orders)} of ${num(k.targetUnits)}`, hint: HINT.orders },
          { label: "Order value", value: inr(k.revenue), sub: `target ${inr(k.targetRevenue ?? 0)}`, hint: HINT.revenue },
          { label: "Team", value: `${reps.length} people`, sub: `Manager: ${manager?.name ?? "not set"}` },
        ]}
      />

      <div className="grid grid-kpi" data-tour="kpis">
        <Kpi label="Enquiries that became orders" value={pct(k.conversion, 1)} sub={`from ${num(k.leadsCreated)} enquiries`} hint={HINT.conversion} />
        <Kpi label="First reply time" value={k.avgFirstContactHours !== null ? `${num(k.avgFirstContactHours)} h` : "—"} sub="from enquiry to first call" hint={HINT.firstContact} />
        <Kpi label="Still in progress" value={num(k.openPipelineCount)} sub={`worth ${inr(k.openPipelineValue)}`} hint={HINT.pipeline} />
        <Kpi label="Cars delivered" value={num(k.deliveries)} sub={`${num(k.avgDaysToDeliver, 1)} days on average`} hint={HINT.deliveries} />
        <Link href={`/dashboard/followups?branch=${id}`}>
          <Kpi label="Needs a follow-up" value={num(k.staleCount + k.stuckOrders)} tone={k.staleCount + k.stuckOrders ? "bad" : "good"}
            sub={`${k.staleCount} quiet customers · ${k.stuckOrders} late deliveries →`} hint={HINT.followUp} />
        </Link>
      </div>

      <ConfirmedFindings branchId={id} />
      <Card title="What needs attention" subtitle="Most urgent first." tour="attention">
        <InsightList items={ins} />
      </Card>

      <div className="grid grid-2">
        <Card
          title="Orders against target"
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
        <Card title="From enquiry to delivery" subtitle="How far this period's enquiries got">
          <FunnelChart steps={steps} />
        </Card>
      </div>

      <div className="grid grid-3-1">
        <Card title="The team" subtitle="Select a person to see their customers">
          <RepTable rows={reps} />
        </Card>
        <Card title="Cars ordered by person" subtitle={rangeLabel(range)}>
          <CompareChart data={reps.map((r) => ({ name: r.rep.name, value: r.orders })).sort((a, b) => b.value - a.value)} valueLabel="Cars ordered" />
        </Card>
      </div>

      <Card
        title="Customers going quiet"
        subtitle="Still interested, but nobody has been in touch for a week or more"
        actions={<Link href={`/dashboard/followups?branch=${id}`} className="btn btn-sm">See all follow-ups</Link>}
      >
        <LeadTable leads={stale.slice(0, 8)} model={model} empty="Good news: every customer in progress has been contacted in the last week." />
      </Card>
    </div>
  );
}
