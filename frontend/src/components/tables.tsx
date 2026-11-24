"use client";

import Link from "next/link";
import type { BranchRow, EnrichedLead, Model, RepRow } from "@/lib/analytics";
import { dateLabel, inr, num, pct, STATUS_LABEL, titleCase } from "@/lib/format";
import { ConfirmedBadge } from "./ConfirmedFindings";
import { Column, DataTable, MiniBar, toneFor } from "./ui";

const STATUS_BADGE: Record<string, string> = {
  new: "badge-info", contacted: "badge-info", test_drive: "badge-info", negotiation: "badge-warn",
  order_placed: "badge-warn", delivered: "badge-good", lost: "badge-bad",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? ""}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function Attainment({ value }: { value: number | null }) {
  if (value === null) return <span className="subtle">—</span>;
  return (
    <span>
      <MiniBar value={value} />
      <span className={`tone-${toneFor(value)} cell-strong`}>{pct(value)}</span>
    </span>
  );
}

function Stale({ n }: { n: number }) {
  return n > 0 ? <span className={`badge ${n >= 3 ? "badge-bad" : "badge-warn"}`}>{n}</span> : <span className="subtle">0</span>;
}

export function BranchTable({ rows }: { rows: BranchRow[] }) {
  const cols: Column<BranchRow>[] = [
    { key: "name", label: "Branch", sort: (r) => r.branch.name, render: (r) => (
      <div><div className="cell-link">{r.branch.name} <ConfirmedBadge branchId={r.branch.id} /></div><div className="subtle">{r.branch.city} · {r.manager?.name ?? "No manager"}</div></div>
    ) },
    { key: "att", label: "Target reached", sort: (r) => r.unitAttainment ?? -1, render: (r) => <Attainment value={r.unitAttainment} /> },
    { key: "orders", label: "Cars ordered / target", num: true, sort: (r) => r.orders, render: (r) => `${num(r.orders)} / ${num(r.targetUnits)}` },
    { key: "rev", label: "Order value", num: true, sort: (r) => r.revenue, render: (r) => inr(r.revenue) },
    { key: "leads", label: "Enquiries", num: true, sort: (r) => r.leadsCreated, render: (r) => num(r.leadsCreated) },
    { key: "conv", label: "Conversion", num: true, sort: (r) => r.conversion ?? -1, render: (r) => pct(r.conversion, 1) },
    { key: "resp", label: "First reply", num: true, sort: (r) => r.avgFirstContactHours ?? 1e9, render: (r) => r.avgFirstContactHours !== null ? `${num(r.avgFirstContactHours, 0)} h` : "—" },
    { key: "stale", label: "Going quiet", num: true, sort: (r) => r.staleCount, render: (r) => <Stale n={r.staleCount} /> },
  ];
  return (
    <DataTable rows={rows} columns={cols} rowKey={(r) => r.branch.id}
      href={(r) => `/dashboard/branch/${r.branch.id}`} initialSort={{ key: "att", dir: "asc" }} />
  );
}

export function RepTable({ rows, showBranch }: { rows: RepRow[]; showBranch?: boolean }) {
  const cols: Column<RepRow>[] = [
    { key: "name", label: "Person", sort: (r) => r.rep.name, render: (r) => (
      <div><div className="cell-link">{r.rep.name} <ConfirmedBadge repId={r.rep.id} /></div>
        <div className="subtle">{titleCase(r.rep.role)}{showBranch && r.branch ? ` · ${r.branch.name}` : ""}</div></div>
    ) },
    { key: "leads", label: "Enquiries", num: true, sort: (r) => r.leadsCreated, render: (r) => num(r.leadsCreated) },
    { key: "orders", label: "Cars ordered", num: true, sort: (r) => r.orders, render: (r) => num(r.orders) },
    { key: "conv", label: "Conversion", num: true, sort: (r) => r.conversion ?? -1, render: (r) => (
      <span><MiniBar value={r.conversion !== null ? r.conversion * 2.5 : null} tone="" />{pct(r.conversion, 1)}</span>
    ) },
    { key: "rev", label: "Order value", num: true, sort: (r) => r.revenue, render: (r) => inr(r.revenue) },
    { key: "resp", label: "First reply", num: true, sort: (r) => r.avgFirstContactHours ?? 1e9, render: (r) => r.avgFirstContactHours !== null ? `${num(r.avgFirstContactHours, 0)} h` : "—" },
    { key: "open", label: "In progress", num: true, sort: (r) => r.openPipelineCount, render: (r) => num(r.openPipelineCount) },
    { key: "stale", label: "Going quiet", num: true, sort: (r) => r.staleCount, render: (r) => <Stale n={r.staleCount} /> },
  ];
  return (
    <DataTable rows={rows} columns={cols} rowKey={(r) => r.rep.id}
      href={(r) => `/dashboard/rep/${r.rep.id}`} initialSort={{ key: "orders", dir: "desc" }} />
  );
}

export function LeadTable({ leads, model, mode = "activity", empty }: {
  leads: EnrichedLead[];
  model: Model;
  mode?: "activity" | "orders" | "all";
  empty?: string;
}) {
  const cols: Column<EnrichedLead>[] = [
    { key: "cust", label: "Customer", sort: (l) => l.customer_name, render: (l) => (
      <div><div className="cell-strong">{l.customer_name}</div><div className="subtle">{l.id} · {l.phone}</div></div>
    ) },
    { key: "model", label: "Car", sort: (l) => l.model_interested, render: (l) => l.model_interested },
    { key: "status", label: "Stage", sort: (l) => l.maxStage, render: (l) => <StatusBadge status={l.status} /> },
    { key: "rep", label: "Handled by", sort: (l) => model.repById.get(l.assigned_to)?.name ?? "", render: (l) => (
      <Link href={`/dashboard/rep/${l.assigned_to}`} className="cell-link" onClick={(e) => e.stopPropagation()}>
        {model.repById.get(l.assigned_to)?.name ?? l.assigned_to}
      </Link>
    ) },
    { key: "value", label: "Deal value", num: true, sort: (l) => l.deal_value, render: (l) => inr(l.deal_value) },
  ];
  if (mode === "orders") {
    cols.splice(2, 1); // stage is always "order placed" here
    cols.push({ key: "ordered", label: "Ordered on", sort: (l) => l.orderAt ?? 0, render: (l) => l.orderAt ? dateLabel(new Date(l.orderAt).toISOString()) : "—" });
    cols.push({ key: "wait", label: "Waiting for", num: true, sort: (l) => model.asOf - (l.orderAt ?? model.asOf), render: (l) => {
      const d = Math.floor((model.asOf - (l.orderAt ?? model.asOf)) / 86_400_000);
      return <span className={`badge ${d >= 60 ? "badge-bad" : "badge-warn"}`}>{d} days</span>;
    } });
  } else {
    cols.push({ key: "source", label: "Source", sort: (l) => l.source, render: (l) => titleCase(l.source) });
    cols.push({ key: "idle", label: "Last contact", num: true, sort: (l) => l.daysSinceActivity, render: (l) => {
      const d = Math.floor(l.daysSinceActivity);
      const open = ["new", "contacted", "test_drive", "negotiation"].includes(l.status);
      return open && d >= 7 ? <span className={`badge ${d >= 14 ? "badge-bad" : "badge-warn"}`}>{d} days ago</span> : <span className="subtle">{d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`}</span>;
    } });
    cols.push({ key: "note", label: "Last note", render: (l) => (
      <span className="subtle" style={{ whiteSpace: "normal", display: "block", minWidth: 180, maxWidth: 320 }}>
        {l.status_history[l.status_history.length - 1]?.note ?? "—"}
      </span>
    ) });
  }
  return (
    <DataTable rows={leads} columns={cols} rowKey={(l) => l.id} empty={empty}
      initialSort={mode === "orders" ? { key: "wait", dir: "desc" } : { key: "idle", dir: "desc" }} />
  );
}
