import { insights, Model, staleLeads, stuckOrders } from "./analytics";
import { monthLabel, STATUS_LABEL } from "./format";
import type { User } from "./user";

export interface Notice {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  href: string;
  /** Epoch ms the item became relevant; used for "3 days ago". */
  at: number;
}

const DAY = 86_400_000;
const MAX = 40;

/** Things this person should act on, newest-relevant first. */
export function noticesFor(m: Model, u: User): Notice[] {
  const out: Notice[] = [];
  const last = m.months[m.months.length - 1];
  const thisMonth = { from: last, to: last };

  if (u.role === "rep" && u.repId) {
    const scope = { repId: u.repId };
    for (const l of stuckOrders(m, scope)) {
      out.push({
        id: `stuck:${l.id}`, severity: "critical", at: l.orderAt ?? m.asOf,
        title: `${l.customer_name}'s ${l.model_interested} hasn't been delivered`,
        body: `Ordered ${Math.floor((m.asOf - (l.orderAt ?? m.asOf)) / DAY)} days ago. Check allocation and finance, then update the customer.`,
        href: `/dashboard/followups?rep=${u.repId}&view=orders`,
      });
    }
    for (const l of staleLeads(m, scope)) {
      out.push({
        id: `stale:${l.id}`, severity: l.daysSinceActivity >= 14 ? "critical" : "warning",
        at: Date.parse(l.last_activity_at),
        title: `Follow up with ${l.customer_name}`,
        body: `${l.model_interested} · ${STATUS_LABEL[l.status]} · no contact for ${Math.floor(l.daysSinceActivity)} days.`,
        href: `/dashboard/followups?rep=${u.repId}`,
      });
    }
    // Fresh leads still waiting for a first call (not yet "stale" but urgent).
    for (const l of m.leads) {
      if (l.assigned_to === u.repId && l.status === "new" && l.daysSinceActivity >= 1 && l.daysSinceActivity < 7) {
        out.push({
          id: `new:${l.id}`, severity: "info", at: Date.parse(l.created_at),
          title: `New lead waiting for a first call: ${l.customer_name}`,
          body: `Interested in the ${l.model_interested} (${l.source.replace("_", " ")}).`,
          href: `/dashboard/rep/${u.repId}`,
        });
      }
    }
  } else {
    const scope = u.role === "manager" && u.branchId ? { branchId: u.branchId } : {};
    for (const i of insights(m, thisMonth, scope)) {
      if (i.severity === "positive") continue;
      out.push({
        id: `insight:${i.id}:${last}:${u.branchId ?? "all"}`,
        severity: i.severity === "info" ? "info" : i.severity,
        at: m.asOf,
        title: i.title,
        body: i.action ? `${i.detail} ${i.action}` : i.detail,
        href: i.href ?? (u.role === "manager" ? `/dashboard/branch/${u.branchId}` : "/dashboard"),
      });
    }
    if (u.role === "ceo") {
      // One line per branch that is far behind this month.
      for (const b of m.branches) {
        const t = m.targets.find((x) => x.branch_id === b.id && x.month === last);
        if (!t) continue;
        const orders = m.leads.filter((l) => l.branch_id === b.id && l.orderMonth === last).length;
        if (orders / t.target_units < 0.5) {
          out.push({
            id: `behind:${b.id}:${last}`, severity: "warning", at: m.asOf,
            title: `${b.name} reached ${Math.round((orders / t.target_units) * 100)}% of its ${monthLabel(last)} target`,
            body: `${orders} of ${t.target_units} units. Review the pipeline with the branch manager.`,
            href: `/dashboard/branch/${b.id}`,
          });
        }
      }
    } else if (u.branchId) {
      // Managers: reps with several leads going cold.
      const stale = staleLeads(m, { branchId: u.branchId });
      const byRep = new Map<string, number>();
      stale.forEach((l) => byRep.set(l.assigned_to, (byRep.get(l.assigned_to) ?? 0) + 1));
      for (const [repId, n] of byRep) {
        if (n < 2) continue;
        out.push({
          id: `repstale:${repId}:${n}`, severity: "warning", at: m.asOf,
          title: `${m.repById.get(repId)?.name ?? repId} has ${n} leads going cold`,
          body: "No contact in over a week. A quick check-in could save these deals.",
          href: `/dashboard/rep/${repId}`,
        });
      }
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at - a.at).slice(0, MAX);
}
