"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { FunnelStep, MonthPoint } from "@/lib/analytics";
import { inr, num, pct, STATUS_LABEL, titleCase } from "@/lib/format";
import { useChartColors } from "@/lib/theme";
import { Empty } from "./ui";

// Animations off: charts re-render on every filter change and should feel instant.
const NO_ANIM = { isAnimationActive: false } as const;

function useAxis() {
  const c = useChartColors();
  return { c, tick: { fontSize: 12, fill: c.axis }, legend: { fontSize: 12, color: c.axis } };
}

function Tip({ active, payload, label, fmt }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  fmt?: (name: string, v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="t">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ background: p.color }} />
          {p.name}: <strong>{fmt ? fmt(p.name, p.value) : num(p.value)}</strong>
        </div>
      ))}
    </div>
  );
}

/** Orders (bars) vs target (line) per month. */
export function TargetChart({ data, metric }: { data: MonthPoint[]; metric: "units" | "revenue" }) {
  const { c, tick, legend } = useAxis();
  if (!data.length) return <Empty>No months in the selected period.</Empty>;
  const hasTarget = data.some((d) => d.targetUnits !== null);
  const rows = data.map((d) => ({
    label: d.label,
    Actual: metric === "units" ? d.orders : d.revenue,
    Target: metric === "units" ? d.targetUnits : d.targetRevenue,
  }));
  const fmt = (v: number) => (metric === "revenue" ? inr(v) : num(v));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} />
        <YAxis tick={tick} axisLine={false} tickLine={false} width={metric === "revenue" ? 70 : 40}
          tickFormatter={(v: number) => (metric === "revenue" ? inr(v, 0) : String(v))} />
        <Tooltip content={<Tip fmt={(_, v) => fmt(v)} />} cursor={{ fill: c.cursor }} />
        <Legend wrapperStyle={legend} />
        <Bar {...NO_ANIM} dataKey="Actual" name={metric === "units" ? "Cars ordered" : "Order value"} fill={c.data} radius={[4, 4, 0, 0]} maxBarSize={40} />
        {hasTarget && <Line {...NO_ANIM} dataKey="Target" name="Target" stroke={c.signal} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: c.signal }} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Lead inflow vs orders vs deliveries per month. */
export function ActivityChart({ data }: { data: MonthPoint[] }) {
  const { c, tick, legend } = useAxis();
  if (!data.length) return <Empty>No months in the selected period.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="label" tick={tick} axisLine={false} tickLine={false} />
        <YAxis tick={tick} axisLine={false} tickLine={false} width={36} />
        <Tooltip content={<Tip />} cursor={{ fill: c.cursor }} />
        <Legend wrapperStyle={legend} />
        <Bar {...NO_ANIM} dataKey="leads" name="New enquiries" fill={c.dataSoft} radius={[4, 4, 0, 0]} maxBarSize={28} />
        <Bar {...NO_ANIM} dataKey="orders" name="Cars ordered" fill={c.data} radius={[4, 4, 0, 0]} maxBarSize={28} />
        <Bar {...NO_ANIM} dataKey="deliveries" name="Cars delivered" fill={c.go} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const { c, tick } = useAxis();
  if (!steps.length || steps[0].count === 0) return <Empty>No enquiries came in during this period.</Empty>;
  const rows = steps.map((s) => ({ name: STATUS_LABEL[s.stage], count: s.count, rate: s.overallRate ?? 0, step: s.stepRate }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" tick={tick} axisLine={false} tickLine={false} width={100} />
        <Tooltip
          cursor={{ fill: c.cursor }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as (typeof rows)[number];
            return (
              <div className="chart-tooltip">
                <div className="t">{r.name}</div>
                <div>{num(r.count)} people · {pct(r.rate)} of all enquiries</div>
                {r.step !== null && <div>{pct(r.step)} made it from the step before</div>}
              </div>
            );
          }}
        />
        <Bar {...NO_ANIM} dataKey="count" radius={[0, 6, 6, 0]} label={{ position: "right", fontSize: 12, fill: c.label, formatter: (v: unknown) => num(Number(v)) }}>
          {rows.map((_, i) => <Cell key={i} fill={c.ramp[i]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bar list for reasons/categories. */
export function ReasonChart({ data, height }: { data: { name: string; value: number }[]; height?: number }) {
  const { c, tick } = useAxis();
  if (!data.length) return <Empty>Nothing was recorded for this period.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" tick={tick} axisLine={false} tickLine={false} width={190} />
        <Tooltip content={<Tip />} cursor={{ fill: c.cursor }} />
        <Bar {...NO_ANIM} dataKey="value" name="Leads" fill={c.signal} radius={[0, 4, 4, 0]} maxBarSize={18}
          label={{ position: "right", fontSize: 12, fill: c.label }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Conversion rate by segment (source / model), bar = lead volume. */
export function SegmentChart({ data }: { data: { name: string; leads: number; conversion: number | null }[] }) {
  const { c, tick, legend } = useAxis();
  if (!data.length) return <Empty>No enquiries in this period.</Empty>;
  const rows = data.map((d) => ({ name: titleCase(d.name), leads: d.leads, conversion: (d.conversion ?? 0) * 100 }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="name" tick={{ ...tick, fontSize: 11 }} axisLine={false} tickLine={false} interval={0}
          tickFormatter={(v: string) => (v.length > 11 ? `${v.slice(0, 10)}…` : v)} />
        <YAxis yAxisId="l" tick={tick} axisLine={false} tickLine={false} width={36} />
        <YAxis yAxisId="r" orientation="right" tick={tick} axisLine={false} tickLine={false} width={40} unit="%" />
        <Tooltip content={<Tip fmt={(n, v) => (n === "Became an order" ? `${v.toFixed(1)}%` : num(v))} />} cursor={{ fill: c.cursor }} />
        <Legend wrapperStyle={legend} />
        <Bar {...NO_ANIM} yAxisId="l" dataKey="leads" name="Enquiries" fill={c.dataSoft} radius={[4, 4, 0, 0]} maxBarSize={36} />
        <Line {...NO_ANIM} yAxisId="r" dataKey="conversion" name="Became an order" stroke={c.signal} strokeWidth={2} dot={{ r: 4, fill: c.signal }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Compare entities (branches/reps) on one metric. */
export function CompareChart({ data, valueLabel, fmt, tone = "data" }: {
  data: { name: string; value: number }[];
  valueLabel: string;
  fmt?: (v: number) => string;
  tone?: "data" | "signal";
}) {
  const { c, tick } = useAxis();
  if (!data.length) return <Empty>Nothing to compare yet.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, left: 8, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" tick={tick} axisLine={false} tickLine={false} width={140} />
        <Tooltip content={<Tip fmt={(_, v) => (fmt ? fmt(v) : num(v))} />} cursor={{ fill: c.cursor }} />
        <Bar {...NO_ANIM} dataKey="value" name={valueLabel} fill={tone === "signal" ? c.signal : c.data} radius={[0, 4, 4, 0]} maxBarSize={18}
          label={{ position: "right", fontSize: 12, fill: c.label, formatter: (v: unknown) => (fmt ? fmt(Number(v)) : num(Number(v))) }} />
      </BarChart>
    </ResponsiveContainer>
  );
}
