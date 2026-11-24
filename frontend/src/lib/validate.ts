import { DealershipData, LEAD_STATUSES, REP_ROLES } from "./types";

export interface ValidationIssue {
  /** Technical location, e.g. leads[3].status */
  path: string;
  /** Plain-language location, e.g. Lead 4 (L0004), Status */
  where: string;
  /** Section the issue belongs to, for grouping. */
  section: string;
  message: string;
}

export const SECTION_LABEL: Record<string, string> = {
  $: "The file", metadata: "About this file", branches: "Branches", sales_reps: "Sales team",
  leads: "Leads", targets: "Monthly targets", deliveries: "Deliveries", file: "The file", sample: "Sample data",
};
const ITEM_LABEL: Record<string, string> = {
  branches: "Branch", sales_reps: "Team member", leads: "Lead", targets: "Target", deliveries: "Delivery",
};

const fieldLabel = (f: string) => f.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase());

/** Turns leads[3].status_history[1].timestamp into "Lead 4 (L0004), history step 2, Timestamp". */
function describePath(path: string, input: unknown): { where: string; section: string } {
  const m = path.match(/^(\w+)(?:\[(\d+)\])?(?:\.status_history\[(\d+)\])?(?:\.(\w+))?$/);
  if (!m) return { where: SECTION_LABEL[path] ?? path, section: SECTION_LABEL[path] ?? "The file" };
  const [, coll, idx, hist, field] = m;
  const section = SECTION_LABEL[coll] ?? coll;
  if (idx === undefined) return { where: `${section} section`, section };
  const rec = isObj(input) && Array.isArray(input[coll]) ? (input[coll] as unknown[])[Number(idx)] : undefined;
  const id = isObj(rec) ? (rec.id ?? rec.lead_id ?? (rec.branch_id && rec.month ? `${rec.branch_id}, ${rec.month}` : undefined)) : undefined;
  const parts = [`${ITEM_LABEL[coll] ?? coll} ${Number(idx) + 1}${typeof id === "string" ? ` (${id})` : ""}`];
  if (hist !== undefined) parts.push(`history step ${Number(hist) + 1}`);
  if (field) parts.push(fieldLabel(field));
  return { where: parts.join(", "), section };
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Total number of errors found (errors[] is capped for display). */
  errorCount: number;
  data?: DealershipData;
  counts?: Record<string, number>;
}

const MAX_REPORTED = 500;

type FieldType = "string" | "number" | "date" | "month" | "string?" | "date?";

interface FieldSpec {
  type: FieldType;
  enum?: readonly string[];
}

/** The expected JSON structure. Also rendered on the upload screen. */
export const SCHEMA: Record<string, Record<string, FieldSpec>> = {
  branches: {
    id: { type: "string" },
    name: { type: "string" },
    city: { type: "string" },
  },
  sales_reps: {
    id: { type: "string" },
    name: { type: "string" },
    branch_id: { type: "string" },
    role: { type: "string", enum: REP_ROLES },
    joined: { type: "date" },
  },
  leads: {
    id: { type: "string" },
    customer_name: { type: "string" },
    phone: { type: "string" },
    source: { type: "string" },
    model_interested: { type: "string" },
    status: { type: "string", enum: LEAD_STATUSES },
    assigned_to: { type: "string" },
    branch_id: { type: "string" },
    created_at: { type: "date" },
    last_activity_at: { type: "date" },
    expected_close_date: { type: "date?" },
    deal_value: { type: "number" },
    lost_reason: { type: "string?" },
  },
  targets: {
    branch_id: { type: "string" },
    month: { type: "month" },
    target_units: { type: "number" },
    target_revenue: { type: "number" },
  },
  deliveries: {
    lead_id: { type: "string" },
    order_date: { type: "date" },
    delivery_date: { type: "date" },
    days_to_deliver: { type: "number" },
    delay_reason: { type: "string?" },
  },
};

export const STATUS_EVENT_SCHEMA: Record<string, FieldSpec> = {
  status: { type: "string", enum: LEAD_STATUSES },
  timestamp: { type: "date" },
  note: { type: "string?" },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkField(value: unknown, spec: FieldSpec): string | null {
  const optional = spec.type.endsWith("?");
  if (value === undefined) return optional ? null : "is missing";
  if (value === null) return optional ? null : "is empty (null) but needs a value";
  const base = spec.type.replace("?", "");
  switch (base) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return `should be a number, but it is ${describe(value)}`;
      if (value < 0) return "can't be negative";
      return null;
    case "string":
      if (typeof value !== "string") return `should be text, but it is ${describe(value)}`;
      if (!optional && value.trim() === "") return "is blank";
      if (spec.enum && !spec.enum.includes(value))
        return `is "${value}", which isn't allowed. Use one of: ${spec.enum.join(", ")}`;
      return null;
    case "date":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
        return `should be a date like 2025-06-01 or 2025-06-01T10:30:00Z, but it is ${JSON.stringify(value)}`;
      return null;
    case "month":
      if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
        return `should be a month like 2025-06, but it is ${JSON.stringify(value)}`;
      return null;
  }
  return null;
}

export function validateDealershipData(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let errorCount = 0;
  const err = (path: string, message: string) => {
    errorCount++;
    if (errors.length < MAX_REPORTED) errors.push({ path, message, ...describePath(path, input) });
  };
  const warn = (path: string, message: string) => {
    if (warnings.length < MAX_REPORTED) warnings.push({ path, message, ...describePath(path, input) });
  };

  if (!isObj(input)) {
    err("$", `should start with { and contain the sections listed on the right, but it is ${describe(input)}`);
    return { ok: false, errors, warnings, errorCount };
  }

  if (input.metadata !== undefined && !isObj(input.metadata)) {
    err("metadata", "should be a group of fields inside { }");
  }

  // Structure and field types
  for (const [collection, fields] of Object.entries(SCHEMA)) {
    const arr = input[collection];
    if (arr === undefined) {
      err(collection, "is missing. Every file needs this section, even if it's empty: []");
      continue;
    }
    if (!Array.isArray(arr)) {
      err(collection, `should be a list inside [ ], but it is ${describe(arr)}`);
      continue;
    }
    if (arr.length === 0 && collection !== "deliveries") {
      err(collection, "is empty. Add at least one entry");
    }
    arr.forEach((rec, i) => {
      const p = `${collection}[${i}]`;
      if (!isObj(rec)) {
        err(p, `should be a group of fields inside { }, but it is ${describe(rec)}`);
        return;
      }
      for (const [field, spec] of Object.entries(fields)) {
        const problem = checkField(rec[field], spec);
        if (problem) err(`${p}.${field}`, problem);
      }
      if (collection === "leads") {
        const hist = rec.status_history;
        if (!Array.isArray(hist)) {
          err(`${p}.status_history`, `should be a list of status changes inside [ ], but it is ${describe(hist)}`);
        } else if (hist.length === 0) {
          err(`${p}.status_history`, "is empty. Every lead needs at least its first \"new\" status");
        } else {
          hist.forEach((ev, j) => {
            const hp = `${p}.status_history[${j}]`;
            if (!isObj(ev)) return err(hp, "should be a group of fields inside { }");
            for (const [field, spec] of Object.entries(STATUS_EVENT_SCHEMA)) {
              const problem = checkField(ev[field], spec);
              if (problem) err(`${hp}.${field}`, problem);
            }
          });
          const last = hist[hist.length - 1];
          if (isObj(last) && last.status !== rec.status) {
            warn(p, `is marked "${rec.status}", but its history ends at "${last.status}". DealerPulse goes by the history and treats it as "${last.status}". Your file is not changed`);
          }
        }
      }
    });
  }

  // Stop before referential checks if the shape is broken.
  if (errorCount > 0) return { ok: false, errors, warnings, errorCount };

  const d = input as unknown as DealershipData;

  const dupes = (name: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) err(`${name}[${i}].id`, `uses the ID "${id}", which another entry already has. IDs must be unique`);
      seen.add(id);
    });
    return seen;
  };
  const branchIds = dupes("branches", d.branches.map((b) => b.id));
  const repIds = dupes("sales_reps", d.sales_reps.map((r) => r.id));
  const leadIds = dupes("leads", d.leads.map((l) => l.id));

  d.sales_reps.forEach((r, i) => {
    if (!branchIds.has(r.branch_id))
      err(`sales_reps[${i}].branch_id`, `points to branch "${r.branch_id}", which isn't in the branches list`);
  });
  d.leads.forEach((l, i) => {
    if (!branchIds.has(l.branch_id)) err(`leads[${i}].branch_id`, `points to branch "${l.branch_id}", which isn't in the branches list`);
    if (!repIds.has(l.assigned_to)) err(`leads[${i}].assigned_to`, `is assigned to "${l.assigned_to}", who isn't in the sales reps list`);
  });
  const targetKeys = new Set<string>();
  d.targets.forEach((t, i) => {
    if (!branchIds.has(t.branch_id)) err(`targets[${i}].branch_id`, `points to branch "${t.branch_id}", which isn't in the branches list`);
    const key = `${t.branch_id}|${t.month}`;
    if (targetKeys.has(key)) err(`targets[${i}]`, `is a second target for ${t.branch_id} in ${t.month}. Keep one per branch per month`);
    targetKeys.add(key);
  });
  d.deliveries.forEach((dl, i) => {
    if (!leadIds.has(dl.lead_id)) err(`deliveries[${i}].lead_id`, `refers to lead "${dl.lead_id}", which isn't in the leads list`);
    if (Date.parse(dl.delivery_date) < Date.parse(dl.order_date))
      warn(`deliveries[${i}]`, "has a delivery date earlier than its order date");
  });

  const counts = {
    branches: d.branches.length,
    sales_reps: d.sales_reps.length,
    leads: d.leads.length,
    targets: d.targets.length,
    deliveries: d.deliveries.length,
  };

  return {
    ok: errorCount === 0,
    errors,
    warnings,
    errorCount,
    data: errorCount === 0 ? d : undefined,
    counts,
  };
}

/** Parse raw text and validate; reports JSON syntax errors with line/column. */
export function parseAndValidate(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const posMatch = msg.match(/position (\d+)/);
    let where = "";
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const before = text.slice(0, pos);
      const line = before.split("\n").length;
      const col = pos - before.lastIndexOf("\n");
      where = ` (line ${line}, column ${col})`;
    }
    return {
      ok: false,
      errors: [{ path: "$", where: `The file${where}`, section: "The file", message: `isn't valid JSON. Usually this is a missing comma, quote or bracket near this spot. (${msg})` }],
      warnings: [],
      errorCount: 1,
    };
  }
  return validateDealershipData(parsed);
}
