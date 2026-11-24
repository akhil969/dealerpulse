"use client";

import Link from "next/link";
import { useState } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Anomaly, fmtPValue, METHOD_LABEL } from "@/lib/anomaly/detect";
import { useAnomalies } from "@/lib/anomaly/store";
import { dateLabel } from "@/lib/format";
import { useChartColors } from "@/lib/theme";

const DIRECTION = {
  low: { label: "Lower than expected", badge: "badge-bad" },
  high: { label: "Higher than expected", badge: "badge-warn" },
  inconsistent: { label: "Data doesn't add up", badge: "badge-info" },
};
const CATEGORY = { sales: "Sales", team: "Team", delivery: "Deliveries", data: "Data quality" };

function MiniSeries({ s }: { s: NonNullable<Anomaly["series"]> }) {
  const c = useChartColors();
  return (
    <ResponsiveContainer width="100%" height={130}>
      <ComposedChart data={s.points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: c.axis }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: c.axis }} axisLine={false} tickLine={false} width={40} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <ReferenceLine y={s.hi} stroke={c.axis} strokeDasharray="4 4" />
        <ReferenceLine y={s.centre} stroke={c.axis} />
        {s.lo > 0 && <ReferenceLine y={s.lo} stroke={c.axis} strokeDasharray="4 4" />}
        <Line isAnimationActive={false} dataKey="value" name="Count" stroke={c.data} strokeWidth={2}
          dot={(props: { cx?: number; cy?: number; index?: number }) => {
            const flagged = s.points[props.index ?? 0]?.flagged;
            return <circle key={props.index} cx={props.cx} cy={props.cy} r={flagged ? 6 : 3} fill={flagged ? c.signal : c.data} stroke="none" />;
          }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function AnomalyCard({ a }: { a: Anomaly }) {
  const { statusOf, reviews, canReview, review, reopen } = useAnomalies();
  const [note, setNote] = useState("");
  const status = statusOf(a.id);
  const r = reviews[a.id];
  const allowed = canReview(a);
  const dir = DIRECTION[a.direction];

  return (
    <article className={`anomaly card status-${status}`} aria-labelledby={`t-${a.id}`}>
      <div className="anomaly-main">
        <div className="row" style={{ gap: 6 }}>
          <span className={`badge ${dir.badge}`}>{dir.label}</span>
          <span className="badge">{CATEGORY[a.category]}</span>
          <span className={`badge ${a.confidence === "high" ? "badge-info" : ""}`} title="How strong the evidence is">
            {a.confidence === "high" ? "Strong evidence" : "Some evidence"}
          </span>
          {status === "flagged" && <span className="badge badge-warn">Waiting for review</span>}
          {status === "confirmed" && <span className="badge badge-bad">Confirmed problem</span>}
          {status === "dismissed" && <span className="badge badge-good">Reviewed: not a problem</span>}
        </div>
        <h3 id={`t-${a.id}`}>{a.title}</h3>
        <p className="muted">{a.summary}</p>
        <dl className="anomaly-compare">
          <div><dt>What we saw</dt><dd>{a.observed}</dd></div>
          <div><dt>What&apos;s normal</dt><dd>{a.expected}</dd></div>
        </dl>
        {a.series && <MiniSeries s={a.series} />}
        <details className="anomaly-how">
          <summary>How we spotted this ({a.evidence.length} {a.evidence.length === 1 ? "check" : "checks"})</summary>
          <ul>
            {a.evidence.map((e) => (
              <li key={e.method}>
                <strong>{METHOD_LABEL[e.method]}</strong>: {e.statistic}. Flagged because {e.rule}.
                {e.p !== undefined && <> p = {fmtPValue(e.p)}</>}
                {e.q !== undefined && <>, q = {fmtPValue(e.q)}</>}
              </li>
            ))}
          </ul>
          <p className="subtle">The maths behind each check is explained in ANOMALY_DETECTION.md.</p>
        </details>
      </div>

      <div className="anomaly-side">
        {status === "flagged" ? (
          allowed ? (
            <>
              <p className="anomaly-q">Is this a real problem?</p>
              <label className="sr-only" htmlFor={`n-${a.id}`}>Note (optional)</label>
              <textarea id={`n-${a.id}`} className="note" rows={2} placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => review(a.id, "confirmed", note)}>Yes, confirm it</button>
                <button className="btn btn-sm" onClick={() => review(a.id, "dismissed", note)}>No, dismiss</button>
              </div>
              <p className="subtle">Nothing is marked until you confirm it.</p>
            </>
          ) : (
            <p className="subtle">Waiting for {a.branchId ? "the branch manager or leadership" : "leadership"} to review.</p>
          )
        ) : (
          r && (
            <>
              <p className="anomaly-q">{status === "confirmed" ? "Confirmed" : "Dismissed"} by {r.by}</p>
              <p className="subtle">{dateLabel(r.at)}</p>
              {r.note && <blockquote className="review-note">{r.note}</blockquote>}
              {allowed && <button className="link-btn" onClick={() => reopen(a.id, "")}>Undo and review again</button>}
            </>
          )
        )}
        {a.href && <Link href={a.href} className="btn btn-sm">See the details</Link>}
      </div>
    </article>
  );
}
