import {
  Branch,
  DealershipData,
  Delivery,
  FUNNEL_STAGES,
  Lead,
  LeadStatus,
  OPEN_STATUSES,
  SalesRep,
  Target,
} from "./types";
import { inr, monthLabel, pct } from "./format";

const DAY = 86_400_000;
export const STALE_DAYS = 7;
export const STUCK_ORDER_DAYS = 30;

export interface EnrichedLead extends Lead {
  /** The status field as written in the file; `status` itself follows the history. */
  statusInFile: LeadStatus;
  createdMonth: string;
  /** Furthest funnel stage index reached (0 = new … 5 = delivered). */
  maxStage: number;
  stageAt: Partial<Record<LeadStatus, number>>;
  orderAt: number | null;
  orderMonth: string | null;
  lostAt: number | null;
  firstContactHours: number | null;
  daysSinceActivity: number;
  delivery: Delivery | null;
}

export interface Model {
  branches: Branch[];
  reps: SalesRep[];
  branchById: Map<string, Branch>;
  repById: Map<string, SalesRep>;
  leads: EnrichedLead[];
  targets: Target[];
  deliveries: Delivery[];
  months: string[];
  /** "Today" for the dataset: the latest timestamp it contains. */
  asOf: number;
}

export interface Range {
  from: string; // YYYY-MM inclusive
  to: string; // YYYY-MM inclusive
}

export interface Scope {
  branchId?: string;
  repId?: string;
}

const toMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const inRange = (month: string | null, r: Range) => !!month && month >= r.from && month <= r.to;

/** `basis` lets a role-scoped model share "today" and the month list of the full file. */
export function buildModel(data: DealershipData, basis?: { asOf: number; months: string[] }): Model {
  const deliveryByLead = new Map(data.deliveries.map((d) => [d.lead_id, d]));
  let asOf = 0;

  const leads: EnrichedLead[] = data.leads.map((l) => {
    const stageAt: Partial<Record<LeadStatus, number>> = {};
    let maxStage = 0;
    for (const ev of l.status_history) {
      const t = Date.parse(ev.timestamp);
      if (stageAt[ev.status] === undefined) stageAt[ev.status] = t;
      const idx = FUNNEL_STAGES.indexOf(ev.status);
      if (idx > maxStage) maxStage = idx;
      if (t > asOf) asOf = t;
    }
    const lastActivity = Date.parse(l.last_activity_at);
    if (lastActivity > asOf) asOf = lastActivity;
    const created = Date.parse(l.created_at);
    const delivery = deliveryByLead.get(l.id) ?? null;
    let orderAt = stageAt.order_placed ?? null;
    if (orderAt === null && delivery) orderAt = Date.parse(delivery.order_date);
    if (delivery && maxStage < 5) maxStage = 5;
    // The history is the source of truth: a lead marked "lost" without a "lost" step is treated as still open.
    const status = l.status_history[l.status_history.length - 1]?.status ?? l.status;
    return {
      ...l,
      status,
      statusInFile: l.status,
      lost_reason: status === "lost" ? l.lost_reason : null,
      createdMonth: toMonth(created),
      maxStage,
      stageAt,
      orderAt,
      orderMonth: orderAt !== null ? toMonth(orderAt) : null,
      lostAt: stageAt.lost ?? null,
      firstContactHours:
        stageAt.contacted !== undefined ? (stageAt.contacted - created) / 3_600_000 : null,
      daysSinceActivity: 0,
      delivery,
    };
  });
  if (basis) asOf = basis.asOf;
  for (const l of leads) l.daysSinceActivity = (asOf - Date.parse(l.last_activity_at)) / DAY;

  const monthSet = new Set<string>();
  data.targets.forEach((t) => monthSet.add(t.month));
  leads.forEach((l) => monthSet.add(l.createdMonth));
  const months = basis ? basis.months : [...monthSet].sort();

  return {
    branches: data.branches,
    reps: data.sales_reps,
    branchById: new Map(data.branches.map((b) => [b.id, b])),
    repById: new Map(data.sales_reps.map((r) => [r.id, r])),
    leads,
    targets: data.targets,
    deliveries: data.deliveries,
    months,
    asOf,
  };
}

function scoped(m: Model, s: Scope): EnrichedLead[] {
  return m.leads.filter(
    (l) => (!s.branchId || l.branch_id === s.branchId) && (!s.repId || l.assigned_to === s.repId),
  );
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
const safeDiv = (a: number, b: number) => (b > 0 ? a / b : null);

export interface Kpis {
  leadsCreated: number;
  orders: number;
  revenue: number;
  deliveries: number;
  targetUnits: number | null;
  targetRevenue: number | null;
  unitAttainment: number | null;
  revenueAttainment: number | null;
  /** Of leads created in range, share that reached an order. */
  conversion: number | null;
  /** Of leads created in range that are closed, share lost. */
  lossRate: number | null;
  avgDealValue: number | null;
  avgDaysToDeliver: number | null;
  avgFirstContactHours: number | null;
  openPipelineCount: number;
  openPipelineValue: number;
  staleCount: number;
  stuckOrders: number;
}

export function kpis(m: Model, r: Range, s: Scope = {}): Kpis {
  const leads = scoped(m, s);
  const cohort = leads.filter((l) => inRange(l.createdMonth, r));
  const ordered = leads.filter((l) => inRange(l.orderMonth, r));
  const delivered = leads.filter((l) => l.delivery && inRange(l.delivery.delivery_date.slice(0, 7), r));
  const closed = cohort.filter((l) => l.status === "lost" || l.maxStage >= 4);
  const open = leads.filter((l) => OPEN_STATUSES.includes(l.status));

  let targetUnits: number | null = null;
  let targetRevenue: number | null = null;
  if (!s.repId) {
    const ts = m.targets.filter((t) => inRange(t.month, r) && (!s.branchId || t.branch_id === s.branchId));
    if (ts.length) {
      targetUnits = sum(ts.map((t) => t.target_units));
      targetRevenue = sum(ts.map((t) => t.target_revenue));
    }
  }
  const revenue = sum(ordered.map((l) => l.deal_value));

  return {
    leadsCreated: cohort.length,
    orders: ordered.length,
    revenue,
    deliveries: delivered.length,
    targetUnits,
    targetRevenue,
    unitAttainment: targetUnits !== null ? safeDiv(ordered.length, targetUnits) : null,
    revenueAttainment: targetRevenue !== null ? safeDiv(revenue, targetRevenue) : null,
    conversion: safeDiv(cohort.filter((l) => l.maxStage >= 4).length, cohort.length),
    lossRate: safeDiv(closed.filter((l) => l.status === "lost").length, closed.length),
    avgDealValue: avg(ordered.map((l) => l.deal_value)),
    avgDaysToDeliver: avg(delivered.map((l) => l.delivery!.days_to_deliver)),
    avgFirstContactHours: avg(
      cohort.map((l) => l.firstContactHours).filter((h): h is number => h !== null),
    ),
    openPipelineCount: open.length,
    openPipelineValue: sum(open.map((l) => l.deal_value)),
    staleCount: open.filter((l) => l.daysSinceActivity >= STALE_DAYS).length,
    stuckOrders: stuckOrders(m, s).length,
  };
}

export interface MonthPoint {
  month: string;
  label: string;
  leads: number;
  orders: number;
  revenue: number;
  deliveries: number;
  targetUnits: number | null;
  targetRevenue: number | null;
}

export function monthly(m: Model, r: Range, s: Scope = {}): MonthPoint[] {
  const leads = scoped(m, s);
  return m.months
    .filter((mo) => inRange(mo, r))
    .map((mo) => {
      const ts = s.repId
        ? []
        : m.targets.filter((t) => t.month === mo && (!s.branchId || t.branch_id === s.branchId));
      const ordered = leads.filter((l) => l.orderMonth === mo);
      return {
        month: mo,
        label: monthLabel(mo, true),
        leads: leads.filter((l) => l.createdMonth === mo).length,
        orders: ordered.length,
        revenue: sum(ordered.map((l) => l.deal_value)),
        deliveries: leads.filter((l) => l.delivery?.delivery_date.startsWith(mo)).length,
        targetUnits: ts.length ? sum(ts.map((t) => t.target_units)) : null,
        targetRevenue: ts.length ? sum(ts.map((t) => t.target_revenue)) : null,
      };
    });
}

export interface FunnelStep {
  stage: LeadStatus;
  count: number;
  /** Share of the previous stage that reached this one. */
  stepRate: number | null;
  /** Share of all leads that reached this stage. */
  overallRate: number | null;
  /** Leads lost while at this stage. */
  lostHere: number;
}

export function funnel(m: Model, r: Range, s: Scope = {}): FunnelStep[] {
  const cohort = scoped(m, s).filter((l) => inRange(l.createdMonth, r));
  const total = cohort.length;
  return FUNNEL_STAGES.map((stage, i) => {
    const count = cohort.filter((l) => l.maxStage >= i).length;
    const prev = i === 0 ? total : cohort.filter((l) => l.maxStage >= i - 1).length;
    return {
      stage,
      count,
      stepRate: i === 0 ? null : safeDiv(count, prev),
      overallRate: safeDiv(count, total),
      lostHere: cohort.filter((l) => l.status === "lost" && l.maxStage === i).length,
    };
  });
}

export function countBy<T>(items: T[], key: (t: T) => string | null | undefined) {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export function lostReasons(m: Model, r: Range, s: Scope = {}) {
  return countBy(
    scoped(m, s).filter((l) => l.status === "lost" && inRange(l.createdMonth, r)),
    (l) => l.lost_reason ?? "Not recorded",
  );
}

export function delayReasons(m: Model, r: Range, s: Scope = {}) {
  return countBy(
    scoped(m, s).filter((l) => l.delivery && inRange(l.delivery.delivery_date.slice(0, 7), r)),
    (l) => l.delivery!.delay_reason ?? "On time",
  );
}

export interface SegmentRow {
  name: string;
  leads: number;
  orders: number;
  conversion: number | null;
  revenue: number;
}

function segment(leads: EnrichedLead[], key: (l: EnrichedLead) => string): SegmentRow[] {
  const groups = new Map<string, EnrichedLead[]>();
  for (const l of leads) {
    const k = key(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  return [...groups.entries()]
    .map(([name, ls]) => {
      const won = ls.filter((l) => l.maxStage >= 4);
      return {
        name,
        leads: ls.length,
        orders: won.length,
        conversion: safeDiv(won.length, ls.length),
        revenue: sum(won.map((l) => l.deal_value)),
      };
    })
    .sort((a, b) => b.leads - a.leads);
}

export function bySource(m: Model, r: Range, s: Scope = {}) {
  return segment(scoped(m, s).filter((l) => inRange(l.createdMonth, r)), (l) => l.source);
}

export function byModel(m: Model, r: Range, s: Scope = {}) {
  return segment(scoped(m, s).filter((l) => inRange(l.createdMonth, r)), (l) => l.model_interested);
}

export interface BranchRow extends Kpis {
  branch: Branch;
  manager?: SalesRep;
}

export function branchTable(m: Model, r: Range): BranchRow[] {
  return m.branches.map((b) => ({
    branch: b,
    manager: m.reps.find((rep) => rep.branch_id === b.id && rep.role === "branch_manager"),
    ...kpis(m, r, { branchId: b.id }),
  }));
}

export interface RepRow extends Kpis {
  rep: SalesRep;
  branch?: Branch;
}

export function repTable(m: Model, r: Range, branchId?: string): RepRow[] {
  return m.reps
    .filter((rep) => !branchId || rep.branch_id === branchId)
    .map((rep) => ({
      rep,
      branch: m.branchById.get(rep.branch_id),
      ...kpis(m, r, { repId: rep.id }),
    }));
}

/** Open leads with no activity for STALE_DAYS+ days, oldest first. Current state, not time-filtered. */
export function staleLeads(m: Model, s: Scope = {}, days = STALE_DAYS) {
  return scoped(m, s)
    .filter((l) => OPEN_STATUSES.includes(l.status) && l.daysSinceActivity >= days)
    .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);
}

/** Orders placed but not delivered for STUCK_ORDER_DAYS+ days. */
export function stuckOrders(m: Model, s: Scope = {}) {
  return scoped(m, s)
    .filter(
      (l) => l.status === "order_placed" && !l.delivery && l.orderAt !== null &&
        (m.asOf - l.orderAt) / DAY >= STUCK_ORDER_DAYS,
    )
    .sort((a, b) => (a.orderAt ?? 0) - (b.orderAt ?? 0));
}

export function openLeads(m: Model, s: Scope = {}) {
  return scoped(m, s)
    .filter((l) => OPEN_STATUSES.includes(l.status) || (l.status === "order_placed" && !l.delivery))
    .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);
}

export function daysSince(m: Model, ms: number) {
  return Math.floor((m.asOf - ms) / DAY);
}

export type Severity = "critical" | "warning" | "positive" | "info";

export interface Insight {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  action?: string;
  href?: string;
}

/** Plain-language findings a manager can act on, most urgent first. */
export function insights(m: Model, r: Range, s: Scope = {}): Insight[] {
  const out: Insight[] = [];
  const k = kpis(m, r, s);
  const scopeQs = s.branchId ? `?branch=${s.branchId}` : "";
  const branchName = (id: string) => m.branchById.get(id)?.name ?? id;

  // 1. Target attainment
  if (k.targetUnits && k.unitAttainment !== null) {
    const gap = k.targetUnits - k.orders;
    if (k.unitAttainment < 0.9) {
      out.push({
        id: "target-gap",
        severity: k.unitAttainment < 0.5 ? "critical" : "warning",
        title: `${pct(k.unitAttainment)} of the car sales target reached`,
        detail: `${k.orders} cars ordered against a target of ${k.targetUnits}, so ${gap} short for ${rangeLabel(r)}. Order value is ${inr(k.revenue)} of ${inr(k.targetRevenue ?? 0)}.`,
      });
    } else {
      out.push({
        id: "target-hit",
        severity: "positive",
        title: `On track: ${pct(k.unitAttainment)} of the car sales target`,
        detail: `${k.orders} cars ordered against ${k.targetUnits} for ${rangeLabel(r)}.`,
      });
    }
    // Target realism: is lead volume even enough?
    if (k.leadsCreated < k.targetUnits) {
      const needed = k.conversion ? Math.ceil(k.targetUnits / k.conversion) : null;
      out.push({
        id: "lead-volume",
        severity: "critical",
        title: "Too few enquiries to reach the target",
        detail: `Only ${k.leadsCreated} enquiries came in, but the target is ${k.targetUnits} cars. Even if every enquiry bought a car, the target would be missed.${needed ? ` At today's rate (${pct(k.conversion)} of enquiries buy), you would need about ${needed} enquiries.` : ""}`,
        action: "Bring in more enquiries, or set targets that match the enquiries you get.",
      });
    }
  }

  // 2. Worst branch vs target in the latest month (network view only)
  if (!s.branchId && !s.repId) {
    const latest = { from: r.to, to: r.to };
    const rows = branchTable(m, latest).filter((b) => b.unitAttainment !== null);
    rows.sort((a, b) => (a.unitAttainment ?? 0) - (b.unitAttainment ?? 0));
    const worst = rows[0];
    const best = rows[rows.length - 1];
    if (worst && best && worst !== best) {
      out.push({
        id: "worst-branch",
        severity: "warning",
        title: `${worst.branch.name} is furthest behind in ${monthLabel(r.to)}`,
        detail: `${worst.orders} of ${worst.targetUnits} cars (${pct(worst.unitAttainment)}). The best branch, ${best.branch.name}, reached ${pct(best.unitAttainment)}.`,
        action: "Go through the customers in progress with the branch manager.",
        href: `/dashboard/branch/${worst.branch.id}`,
      });
    }
  }

  // 3. Stale leads
  const stale = staleLeads(m, s);
  if (stale.length) {
    const byBranch = countBy(stale, (l) => l.branch_id);
    const top = byBranch[0];
    out.push({
      id: "stale",
      severity: stale.length >= 5 ? "critical" : "warning",
      title: `${stale.length} customer${stale.length > 1 ? "s" : ""} not contacted for ${STALE_DAYS}+ days`,
      detail: `Their deals are worth ${inr(stale.reduce((a, l) => a + l.deal_value, 0))}.${!s.branchId && !s.repId && top ? ` ${branchName(top.name)} has the most (${top.value}).` : ""}`,
      action: "Call them today, before they buy somewhere else.",
      href: `/dashboard/followups${scopeQs}`,
    });
  }

  // 4. Stuck orders
  const stuck = stuckOrders(m, s);
  if (stuck.length) {
    const oldest = stuck[0];
    out.push({
      id: "stuck",
      severity: "critical",
      title: `${stuck.length} car${stuck.length > 1 ? "s" : ""} ordered over ${STUCK_ORDER_DAYS} days ago and not yet delivered`,
      detail: `${inr(stuck.reduce((a, l) => a + l.deal_value, 0))} of sales waiting. The oldest (${oldest.customer_name}, ${oldest.model_interested}) was ordered ${daysSince(m, oldest.orderAt!)} days ago.`,
      action: "Check stock allocation and finance with operations, then update each customer.",
      href: `/dashboard/followups${scopeQs}${scopeQs ? "&" : "?"}view=orders`,
    });
  }

  // 5. Biggest funnel leak
  const f = funnel(m, r, s).slice(1, 5);
  const leak = [...f].sort((a, b) => (a.stepRate ?? 1) - (b.stepRate ?? 1))[0];
  if (leak && leak.stepRate !== null) {
    const idx = FUNNEL_STAGES.indexOf(leak.stage);
    const reasons = lostReasons(m, r, s).filter((x) => x.name !== "Not recorded");
    out.push({
      id: "leak",
      severity: "warning",
      title: `Most customers drop out between ${stageName(FUNNEL_STAGES[idx - 1]).toLowerCase()} and ${stageName(leak.stage).toLowerCase()}`,
      detail: `Only ${pct(leak.stepRate)} carry on to the next step.${reasons[0] ? ` The most common reason customers give for not buying: "${reasons[0].name}" (${reasons[0].value}).` : ""}`,
      href: `/dashboard/funnel${scopeQs}`,
    });
  }

  // 6. Rep spread (branch or network)
  if (!s.repId) {
    const reps = repTable(m, r, s.branchId).filter((x) => x.leadsCreated >= 5 && x.conversion !== null);
    if (reps.length >= 3) {
      reps.sort((a, b) => (b.conversion ?? 0) - (a.conversion ?? 0));
      const top = reps[0];
      const bottom = reps[reps.length - 1];
      out.push({
        id: "reps",
        severity: "info",
        title: `Some salespeople close far more than others: ${pct(bottom.conversion)} to ${pct(top.conversion)}`,
        detail: `${top.rep.name} turns the most enquiries into orders. ${bottom.rep.name} turns the fewest (${bottom.orders} from ${bottom.leadsCreated}).`,
        action: "Pair them up so the strongest can coach the others.",
        href: `/dashboard/rep/${bottom.rep.id}`,
      });
    }
  }

  // 7. Delivery delays
  const delays = delayReasons(m, r, s);
  const delayed = delays.filter((d) => d.name !== "On time");
  const totalDel = delays.reduce((a, d) => a + d.value, 0);
  if (delayed.length && totalDel) {
    const delayedCount = delayed.reduce((a, d) => a + d.value, 0);
    out.push({
      id: "delays",
      severity: delayedCount / totalDel > 0.4 ? "warning" : "info",
      title: `${pct(delayedCount / totalDel)} of deliveries were delayed`,
      detail: `Customers wait ${k.avgDaysToDeliver?.toFixed(1) ?? "—"} days on average from order to handover. Most common cause: ${delayed[0].name.toLowerCase()} (${delayed[0].value}).`,
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, positive: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

function stageName(s: LeadStatus) {
  return (
    { new: "New", contacted: "Contacted", test_drive: "Test drive", negotiation: "Negotiation",
      order_placed: "Ordering", delivered: "Delivery", lost: "Lost" } as Record<LeadStatus, string>
  )[s];
}

export function rangeLabel(r: Range) {
  return r.from === r.to ? monthLabel(r.from) : `${monthLabel(r.from)} – ${monthLabel(r.to)}`;
}
