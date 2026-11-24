"use client";

import { Suspense, useMemo } from "react";
import { BranchSelect, useBranchParam } from "@/components/BranchSelect";
import { CompareChart } from "@/components/charts";
import { LeadTable } from "@/components/tables";
import { Card, exportCsv, Kpi } from "@/components/ui";
import Link from "next/link";
import { countBy, staleLeads, stuckOrders, STALE_DAYS, STUCK_ORDER_DAYS } from "@/lib/analytics";
import { dateLabel, inr, num, STATUS_LABEL } from "@/lib/format";
import { useDashboard } from "@/lib/store";

export default function FollowupsPage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 400 }} />}>
      <Followups />
    </Suspense>
  );
}

const THRESHOLDS = [7, 14, 30];

function Followups() {
  const { model, user } = useDashboard();
  const { branch, params, set } = useBranchParam();
  const view = params.get("view") === "orders" ? "orders" : "leads";
  const days = Number(params.get("days")) || STALE_DAYS;
  const repId = params.get("rep") ?? "";
  const rep = repId ? model.repById.get(repId) : undefined;
  const scope = useMemo(() => (rep ? { repId: rep.id } : branch ? { branchId: branch } : {}), [rep, branch]);

  const stale = useMemo(() => staleLeads(model, scope, days), [model, scope, days]);
  const stuck = useMemo(() => stuckOrders(model, scope), [model, scope]);
  const rows = view === "orders" ? stuck : stale;
  const byRep = useMemo(
    () => countBy(rows, (l) => model.repById.get(l.assigned_to)?.name).slice(0, 10),
    [rows, model],
  );

  function download() {
    exportCsv(
      `dealerpulse-${view === "orders" ? "late-deliveries" : "quiet-customers"}${rep ? `-${rep.id}` : branch ? `-${branch}` : ""}.csv`,
      ["Lead ID", "Customer", "Phone", "Car", "Stage", "Branch", "Handled by", "Deal value", "Last contact", "Days since contact", "Last note"],
      rows.map((l) => [
        l.id, l.customer_name, l.phone, l.model_interested, STATUS_LABEL[l.status],
        model.branchById.get(l.branch_id)?.name ?? l.branch_id,
        model.repById.get(l.assigned_to)?.name ?? l.assigned_to,
        l.deal_value, dateLabel(l.last_activity_at), Math.floor(l.daysSinceActivity),
        l.status_history[l.status_history.length - 1]?.note ?? "",
      ]),
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <p>Customers to call today. This list is always up to date and ignores the months you picked above.</p>
          {rep && (
            <p className="row" style={{ marginTop: 8 }}>
              <span className="chip">Showing {rep.name}&apos;s list</span>
              {user.role !== "rep" && <Link href="/dashboard/followups" className="link-btn">Show everyone</Link>}
            </p>
          )}
        </div>
        <div className="row">
          {!rep && user.role === "ceo" && <BranchSelect value={branch} onChange={(v) => set("branch", v)} />}
          <button className="btn btn-sm" onClick={download} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>

      <div className="grid grid-kpi">
        <button className="card kpi" style={{ textAlign: "left", outline: view === "leads" ? "2px solid var(--brand)" : undefined }} onClick={() => set("view", "")}>
          <span className="kpi-label">Customers going quiet</span>
          <span className="kpi-value tone-bad">{num(stale.length)}</span>
          <span className="kpi-sub">no contact for {days}+ days · worth {inr(stale.reduce((a, l) => a + l.deal_value, 0))}</span>
        </button>
        <button className="card kpi" style={{ textAlign: "left", outline: view === "orders" ? "2px solid var(--brand)" : undefined }} onClick={() => set("view", "orders")}>
          <span className="kpi-label">Late deliveries</span>
          <span className="kpi-value tone-bad">{num(stuck.length)}</span>
          <span className="kpi-sub">ordered over {STUCK_ORDER_DAYS} days ago · {inr(stuck.reduce((a, l) => a + l.deal_value, 0))}</span>
        </button>
        <Kpi label="People with calls to make" value={num(byRep.length)} sub="on this list" />
      </div>

      <div className="grid grid-3-1">
        <Card
          title={view === "orders" ? "Cars ordered but not yet delivered" : "Customers going quiet"}
          subtitle={view === "orders" ? "Longest wait first. Check allocation and finance, then update the customer." : "Longest without contact first. A quick call often saves the sale."}
          actions={view === "leads" ? (
            <div className="seg">
              {THRESHOLDS.map((d) => (
                <button key={d} className={days === d ? "on" : ""} onClick={() => set("days", d === STALE_DAYS ? "" : String(d))}>{d}+ days</button>
              ))}
            </div>
          ) : undefined}
        >
          <LeadTable leads={rows} model={model} mode={view === "orders" ? "orders" : "activity"}
            empty={view === "orders" ? "Nothing late: every order from over 30 days ago has been delivered." : `Nobody has gone ${days}+ days without contact. Nice work.`} />
        </Card>
        <Card title="Who has the most to do" subtitle="Items on this list, per person">
          <CompareChart data={byRep} valueLabel="Items" tone="signal" />
        </Card>
      </div>
    </div>
  );
}
