"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactNode, RefObject, useEffect, useId, useMemo, useState } from "react";
import type { Insight } from "@/lib/analytics";

export function toneFor(attainment: number | null | undefined) {
  if (attainment === null || attainment === undefined) return "";
  if (attainment >= 0.9) return "good";
  if (attainment >= 0.6) return "warn";
  return "bad";
}
const toneColor = { good: "var(--go)", warn: "var(--amber)", bad: "var(--signal)", "": "var(--ink-3)" };

/** Small "?" that explains a number in plain words, on hover or keyboard focus. */
export function Hint({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="hint" tabIndex={0} aria-describedby={id} aria-label="What does this mean?">
      ?
      <span role="tooltip" id={id} className="hint-tip">{text}</span>
    </span>
  );
}

/** Close a popover on outside click or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

export function Kpi({
  label, value, sub, progress, tone, hint,
}: { label: string; value: ReactNode; sub?: ReactNode; progress?: number | null; tone?: string; hint?: string }) {
  const t = (tone ?? (progress !== undefined ? toneFor(progress) : "")) as keyof typeof toneColor;
  return (
    <div className="card kpi">
      <span className="kpi-label">{label}{hint && <Hint text={hint} />}</span>
      <span className={`kpi-value${t ? ` tone-${t}` : ""}`}>{value}</span>
      {progress !== undefined && progress !== null && (
        <div className="kpi-bar"><span style={{ width: `${Math.min(100, progress * 100)}%`, background: toneColor[t] }} /></div>
      )}
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, tour }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; tour?: string }) {
  return (
    <section className="card" data-tour={tour}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const SEV_LABEL = { critical: "Act now", warning: "Watch", info: "Insight", positive: "Good news" };
const SEV_BADGE = { critical: "badge-bad", warning: "badge-warn", info: "badge-info", positive: "badge-good" };

export function InsightList({ items, limit }: { items: Insight[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (!shown.length) return <Empty>No issues flagged for this period.</Empty>;
  return (
    <div className="insights">
      {shown.map((i) => (
        <div key={i.id} className={`insight sev-${i.severity}`}>
          <span className="insight-rail" />
          <div>
            <div className="row" style={{ gap: 8, marginBottom: 2 }}>
              <span className={`badge ${SEV_BADGE[i.severity]}`}>{SEV_LABEL[i.severity]}</span>
              <h3>{i.title}</h3>
            </div>
            <p>{i.detail}</p>
            {i.action && <p className="action">→ {i.action}</p>}
          </div>
          {i.href && <Link href={i.href} className="btn btn-sm no-print">View</Link>}
        </div>
      ))}
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <span>/</span>}
          {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function MiniBar({ value, tone }: { value: number | null; tone?: string }) {
  const t = (tone ?? toneFor(value)) as keyof typeof toneColor;
  return (
    <span className="mini-bar">
      <span style={{ width: `${Math.min(100, (value ?? 0) * 100)}%`, background: toneColor[t] || "var(--data)" }} />
    </span>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  sort?: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

/** Sortable table; rows become links when `href` is given. */
export function DataTable<T>({
  rows, columns, href, initialSort, empty = "Nothing to show.", rowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  href?: (row: T) => string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  empty?: string;
  rowKey: (row: T) => string;
}) {
  const router = useRouter();
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!col?.sort || !sort) return rows;
    const get = col.sort;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return sort.dir === "asc" ? r : -r;
    });
  }, [rows, columns, sort]);

  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.num ? "num " : ""}${c.sort ? "sortable" : ""}`}
                onClick={() =>
                  c.sort && setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === "desc" ? "asc" : "desc" }))
                }
                aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={rowKey(r)}
              className={href ? "clickable" : ""}
              onClick={href ? () => router.push(href(r)) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.num ? "num" : ""}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Download rows as CSV. */
export function exportCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
