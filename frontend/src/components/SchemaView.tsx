import { SCHEMA, STATUS_EVENT_SCHEMA } from "@/lib/validate";

type Spec = { type: string; enum?: readonly string[] };

function typeText(spec: Spec) {
  const optional = spec.type.endsWith("?");
  const base = spec.type.replace("?", "");
  const label =
    spec.enum ? spec.enum.map((e) => `"${e}"`).join(" | ")
    : base === "date" ? "ISO date"
    : base === "month" ? '"YYYY-MM"'
    : base;
  return optional ? `${label} | null` : label;
}

function Fields({ fields, indent }: { fields: Record<string, Spec>; indent: string }) {
  return (
    <>
      {Object.entries(fields).map(([k, spec]) => (
        <span key={k}>
          {indent}
          <span className="k">&quot;{k}&quot;</span>: <span className="t">{typeText(spec)}</span>
          {"\n"}
        </span>
      ))}
    </>
  );
}

/** Renders the required JSON structure, generated from the same SCHEMA the validator uses. */
export function SchemaView() {
  const { leads, ...rest } = SCHEMA;
  return (
    <pre className="schema" aria-label="Expected JSON structure">
      {"{\n"}
      {"  "}<span className="k">&quot;metadata&quot;</span>: <span className="t">object</span>{" "}
      <span className="c">{"// optional"}</span>
      {"\n"}
      {Object.entries({ branches: rest.branches, sales_reps: rest.sales_reps }).map(([name, fields]) => (
        <span key={name}>
          {"  "}<span className="k">&quot;{name}&quot;</span>: [{"{\n"}
          <Fields fields={fields} indent="    " />
          {"  }],\n"}
        </span>
      ))}
      {"  "}<span className="k">&quot;leads&quot;</span>: [{"{\n"}
      <Fields fields={leads} indent="    " />
      {"    "}<span className="k">&quot;status_history&quot;</span>: [{"{\n"}
      <Fields fields={STATUS_EVENT_SCHEMA} indent="      " />
      {"    }]\n"}
      {"  }],\n"}
      {Object.entries({ targets: rest.targets, deliveries: rest.deliveries }).map(([name, fields]) => (
        <span key={name}>
          {"  "}<span className="k">&quot;{name}&quot;</span>: [{"{\n"}
          <Fields fields={fields} indent="    " />
          {"  }]"}{name === "targets" ? "," : ""}{"\n"}
        </span>
      ))}
      {"}\n\n"}
      <span className="c">
        {"// Rules checked on upload:\n"}
        {"// • every collection present and an array (deliveries may be empty)\n"}
        {"// • field types, enums and date formats\n"}
        {"// • unique ids for branches, reps and leads\n"}
        {"// • branch_id / assigned_to / lead_id reference existing records\n"}
        {"// • one target per branch per month"}
      </span>
    </pre>
  );
}
