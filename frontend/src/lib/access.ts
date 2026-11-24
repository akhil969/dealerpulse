/**
 * Role-based access control for the frontend pilot.
 *
 * This file plays the part of the future Flask API: the full file never reaches a page.
 * `scopeData` returns only the rows a role may see (row-level) with each field shown,
 * masked or removed according to FIELD_RULES (field-level). When the API exists, the
 * same policy moves to the server and this becomes a pass-through. See ACCESS_CONTROL.md.
 */
import type { DealershipData, Lead, SalesRep } from "./types";
import type { Role, User } from "./user";

export type FieldRule = "full" | "masked" | "hidden";

/** Row scope per role: which records are returned at all. */
export const ROW_SCOPE: Record<Role, string> = {
  ceo: "All branches, people, leads, targets and deliveries",
  manager: "Their own branch only: its team, leads, targets and deliveries",
  rep: "Their own leads and deliveries, and their own profile and branch name",
};

/** Field-level rules. Anything not listed is "full" for every role that can see the row. */
export const FIELD_RULES = {
  "lead.customer_name": { ceo: "full", manager: "full", rep: "full" },
  "lead.phone": { ceo: "masked", manager: "full", rep: "full" },
  "lead.deal_value": { ceo: "full", manager: "full", rep: "full" },
  "lead.status_history.note": { ceo: "full", manager: "full", rep: "full" },
  "lead.lost_reason": { ceo: "full", manager: "full", rep: "full" },
  "sales_rep.joined": { ceo: "full", manager: "full", rep: "full" },
  "target.target_units": { ceo: "full", manager: "full", rep: "hidden" },
  "target.target_revenue": { ceo: "full", manager: "full", rep: "hidden" },
  "metadata.notes": { ceo: "full", manager: "hidden", rep: "hidden" },
} as const satisfies Record<string, Record<Role, FieldRule>>;

export type FieldKey = keyof typeof FIELD_RULES;
export const fieldRule = (role: Role, field: FieldKey): FieldRule => FIELD_RULES[field][role];

/** Keep the last 3 digits so a customer can still be recognised, e.g. "•••••••594". */
export function maskPhone(phone: string): string {
  return phone.length <= 3 ? "•••" : "•".repeat(phone.length - 3) + phone.slice(-3);
}

function applyLeadFields(l: Lead, role: Role): Lead {
  const out: Lead = { ...l, status_history: l.status_history.map((e) => ({ ...e })) };
  const rule = (f: FieldKey) => fieldRule(role, f);
  if (rule("lead.phone") === "masked") out.phone = maskPhone(l.phone);
  if (rule("lead.phone") === "hidden") out.phone = "";
  if (rule("lead.customer_name") !== "full") out.customer_name = rule("lead.customer_name") === "masked" ? `Customer ${l.id}` : "";
  if (rule("lead.deal_value") === "hidden") out.deal_value = 0;
  if (rule("lead.lost_reason") === "hidden") out.lost_reason = null;
  if (rule("lead.status_history.note") === "hidden") out.status_history.forEach((e) => delete e.note);
  return out;
}

/** The only way pages get data: rows filtered to the role, fields shown/masked/removed. */
export function scopeData(data: DealershipData, user: User): DealershipData {
  const role = user.role;
  const inBranch = (id: string) => role === "ceo" || id === user.branchId;
  const ownLead = (l: Lead) => (role === "rep" ? l.assigned_to === user.repId : inBranch(l.branch_id));
  const visibleRep = (r: SalesRep) => (role === "rep" ? r.id === user.repId : inBranch(r.branch_id));

  const leads = data.leads.filter(ownLead).map((l) => applyLeadFields(l, role));
  const leadIds = new Set(leads.map((l) => l.id));
  const targetsHidden = fieldRule(role, "target.target_units") === "hidden";

  return {
    metadata: data.metadata && {
      ...data.metadata,
      notes: fieldRule(role, "metadata.notes") === "full" ? data.metadata.notes : undefined,
    },
    branches: data.branches.filter((b) => inBranch(b.id)),
    sales_reps: data.sales_reps.filter(visibleRep).map((r) => ({ ...r })),
    leads,
    // shortcut: a hidden target field removes the whole row, since targets carry nothing else useful.
    targets: targetsHidden ? [] : data.targets.filter((t) => inBranch(t.branch_id)).map((t) => ({ ...t })),
    deliveries: data.deliveries.filter((d) => leadIds.has(d.lead_id)).map((d) => ({ ...d })),
  };
}

/** Page-level access: which dashboard routes a role may open. */
export function canOpen(user: User, path: string): boolean {
  if (user.role === "ceo") return true;
  const [, , section, id] = path.split("/"); // "", "dashboard", section, id
  if (user.role === "manager") {
    if (!section) return false;                                  // network overview
    if (section === "branch") return id === user.branchId;
    return ["rep", "funnel", "followups", "anomalies"].includes(section); // rep ids are checked by the scoped data
  }
  // rep
  if (section === "rep") return id === user.repId;
  return ["funnel", "followups", "anomalies"].includes(section ?? "");
}

/** Whether this role may see comparisons against people or branches outside their own scope. */
export const seesBenchmarks = (role: Role) => role === "ceo";
/** Whether this role may see how they rank against peers. */
export const seesPeers = (role: Role) => role !== "rep";
