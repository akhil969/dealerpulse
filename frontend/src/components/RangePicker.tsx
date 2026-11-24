"use client";

import { monthLabel } from "@/lib/format";
import { useDashboard, useStore } from "@/lib/store";

export function RangePicker() {
  const { model, range } = useDashboard();
  const { setRange } = useStore();
  const months = model.months;
  const last = months[months.length - 1];

  const presets = [
    { label: "All months", from: months[0], to: last },
    { label: "Last 3", from: months[Math.max(0, months.length - 3)], to: last },
    { label: "Latest", from: last, to: last },
  ];

  return (
    <div className="range" aria-label="Months to show" data-tour="range">
      <div className="seg" role="group">
        {presets.map((p) => (
          <button
            key={p.label}
            className={range.from === p.from && range.to === p.to ? "on" : ""}
            onClick={() => setRange({ from: p.from, to: p.to })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <select
        aria-label="From month"
        value={range.from}
        onChange={(e) => setRange({ from: e.target.value, to: e.target.value > range.to ? e.target.value : range.to })}
      >
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>
      <span className="subtle">to</span>
      <select
        aria-label="To month"
        value={range.to}
        onChange={(e) => setRange({ to: e.target.value, from: e.target.value < range.from ? e.target.value : range.from })}
      >
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>
    </div>
  );
}
