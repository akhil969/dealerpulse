"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ActivityChart, FunnelChart, ReasonChart } from "@/components/charts";
import { PulseBand } from "@/components/PulseBand";
import { LeadTable } from "@/components/tables";
import { ConfirmedFindings } from "@/components/ConfirmedFindings";
import { Card, Crumbs, Empty, InsightList, Kpi } from "@/components/ui";
import { funnel, insights, kpis, lostReasons, monthly, rangeLabel, repTable } from "@/lib/analytics";
import { dateLabel, inr, num, pct, titleCase } from "@/lib/format";
import { HINT } from "@/lib/hints";
import { seesPeers } from "@/lib/access";
import { useDashboard } from "@/lib/store";
import { homeFor } from "@/lib/user";
import { OPEN_STATUSES } from "@/lib/types";

type View = "open" | "range";

export default function RepPage() {
  const { id } = useParams<{ id: string }>();
  const { model, range, user } = useDashboard();
  const rep = model.repById.get(id);
  const [view, setView] = useState<View>("open");
  const scope = useMemo(() => ({ repId: id }), [id]);

  const k = useMemo(() => kpis(model, range, scope), [model, range, scope]);
  const ins = useMemo(() => insights(model, range, scope), [model, range, scope]);
  const series = useMemo(() => monthly(model, range, scope), [model, range, scope]);
  const steps = useMemo(() => funnel(model, range, scope), [model, range, scope]);
  const reasons = useMemo(() => lostReasons(model, range, scope), [model, range, scope]);
  const peers = useMemo(() => (rep ? repTable(model, range, rep.branch_id) : []), [model, range, rep]);

  if (!rep) {
    return <Empty>We couldn&apos;t find “{id}” in this data. <Link href={homeFor(user)} className="cell-link">Back to my dashboard</Link></Empty>;
  }
  const me = user.repId === id;
  const branch = model.branchById.get(rep.branch_id);
  const ranked = [...peers].sort((a, b) => b.orders - a.orders);
  const rank = ranked.findIndex((p) => p.rep.id === id) + 1;
  const peerConv = peers.filter((p) => p.conversion !== null).map((p) => p.conversion!);
  const avgPeerConv = peerConv.length ? peerConv.reduce((a, b) => a + b, 0) / peerConv.length : null;
  const peersVisible = seesPeers(user.role) && peers.length > 1;
  const ahead = peersVisible && k.conversion !== null && avgPeerConv !== null && k.conversion >= avgPeerConv;

  const repLeads = model.leads.filter((l) => l.assigned_to === id);
  const leads = view === "open"
    ? repLeads.filter((l) => OPEN_STATUSES.includes(l.status) || (l.status === "order_placed" && !l.delivery))
    : repLeads.filter((l) => l.createdMonth >= range.from && l.createdMonth <= range.to);

  return (
    <div className="stack">
      {!me && (
        <Crumbs items={[
          ...(user.role === "ceo" ? [{ label: "All branches", href: "/dashboard" }] : []),
          { label: branch?.name ?? rep.branch_id, href: `/dashboard/branch/${rep.branch_id}` },
          { label: rep.name },
        ]} />
      )}
      <PulseBand
        eyebrow={`${me ? "Your sales" : titleCase(rep.role)} · ${branch?.name} · ${rangeLabel(range)}`}
        verdict={me ? `Hi ${rep.name.split(" ")[0]}, ${ahead ? "you're ahead of your branch" : "here's where you stand"}` : rep.name}
        story={
          <>
            {pct(k.conversion)} of {me ? "your" : "their"} enquiries became orders{peersVisible ? `, against a branch average of ${pct(avgPeerConv)}` : ""}.
            {k.staleCount > 0 && <> <strong>{k.staleCount} customer{k.staleCount > 1 ? "s" : ""} haven&apos;t heard from {me ? "you" : "them"} in a week.</strong></>}
          </>
        }
        gauge={{ value: k.conversion, display: pct(k.conversion), caption: "of enquiries became orders" }}
        stats={[
          { label: "Cars ordered", value: num(k.orders), sub: inr(k.revenue) },
          ...(peersVisible ? [{ label: "Rank in branch", value: rank > 0 ? `#${rank} of ${peers.length}` : "—", hint: HINT.rank }] : [{ label: "Order value", value: inr(k.revenue) }]),
          { label: "Joined", value: dateLabel(rep.joined) },
        ]}
      />

      <div className="grid grid-kpi" data-tour="kpis">
        <Kpi label="Enquiries handled" value={num(k.leadsCreated)} sub={`${pct(k.lossRate)} of finished ones were lost`} hint={HINT.leads} />
        <Kpi label="First reply time" value={k.avgFirstContactHours !== null ? `${num(k.avgFirstContactHours)} h` : "—"} sub="from enquiry to first call" hint={HINT.firstContact} />
        <Kpi label="Still in progress" value={num(k.openPipelineCount)} sub={`worth ${inr(k.openPipelineValue)}`} hint={HINT.pipeline} />
        <Kpi label="Customers going quiet" value={num(k.staleCount)} tone={k.staleCount ? "bad" : "good"} sub="no contact for 7+ days" hint={HINT.quiet} />
      </div>

      <ConfirmedFindings repId={id} />
      <Card title={me ? "What you should do next" : "What needs attention"} tour="attention">
        <InsightList items={ins} />
      </Card>

      <Card
        title={me ? "Your customers" : "Customers"}
        subtitle={view === "open" ? "Everyone still in progress, longest without contact first" : `Every enquiry from ${rangeLabel(range)}`}
        actions={
          <div className="seg" role="group" aria-label="Show">
            <button className={view === "open" ? "on" : ""} aria-pressed={view === "open"} onClick={() => setView("open")}>In progress</button>
            <button className={view === "range" ? "on" : ""} aria-pressed={view === "range"} onClick={() => setView("range")}>All in period</button>
          </div>
        }
      >
        <LeadTable leads={leads} model={model} empty="No customers to show here." />
      </Card>

      <div className="grid grid-2">
        <Card title="Month by month"><ActivityChart data={series} /></Card>
        <Card title="From enquiry to delivery" subtitle="How far this period's enquiries got"><FunnelChart steps={steps} /></Card>
      </div>

      <Card title="Why customers didn't buy" subtitle={rangeLabel(range)}>
        <ReasonChart data={reasons} />
      </Card>
    </div>
  );
}
