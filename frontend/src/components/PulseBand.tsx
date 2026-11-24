"use client";

import { ReactNode, useEffect, useState } from "react";
import { Hint } from "./ui";

const START = -120; // degrees; the dial sweeps 240° like a tachometer
const SWEEP = 240;

function polar(r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a) };
}
function arc(r: number, from: number, to: number) {
  const a = polar(r, START + SWEEP * from);
  const b = polar(r, START + SWEEP * to);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${SWEEP * (to - from) > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

/** Dial with red / amber / green zones and a needle that sweeps in on load. */
export function Gauge({ value, display, caption }: { value: number | null; display: string; caption: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(Math.max(0, Math.min(1, value ?? 0))));
    return () => cancelAnimationFrame(id);
  }, [value]);
  const ticks = Array.from({ length: 11 }, (_, i) => i / 10);

  return (
    <figure className="gauge" aria-label={`${display} ${caption}`}>
      <svg viewBox="0 0 200 170" role="img" aria-hidden="true">
        <path d={arc(80, 0, 1)} className="gauge-track" />
        <path d={arc(80, 0, 0.6)} className="gauge-zone z-bad" />
        <path d={arc(80, 0.6, 0.9)} className="gauge-zone z-warn" />
        <path d={arc(80, 0.9, 1)} className="gauge-zone z-good" />
        {ticks.map((t) => {
          const a = polar(66, START + SWEEP * t);
          const b = polar(t % 0.5 === 0 ? 56 : 60, START + SWEEP * t);
          return <line key={t} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="gauge-tick" />;
        })}
        <g className="gauge-needle" style={{ transform: `rotate(${START + SWEEP * shown}deg)` }}>
          <line x1="100" y1="108" x2="100" y2="34" />
        </g>
        <circle cx="100" cy="100" r="7" className="gauge-hub" />
      </svg>
      <figcaption>
        <span className="gauge-value">{display}</span>
        <span className="gauge-caption">{caption}</span>
      </figcaption>
    </figure>
  );
}

export interface PulseStat {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hint?: string;
}

/** The top band of each dashboard: one dial, one plain-language verdict, a few vitals. */
export function PulseBand({ eyebrow, verdict, story, gauge, stats, actions }: {
  eyebrow: string;
  verdict: string;
  story: ReactNode;
  gauge: { value: number | null; display: string; caption: string };
  stats: PulseStat[];
  actions?: ReactNode;
}) {
  return (
    <section className="pulse" data-tour="pulse">
      <Gauge {...gauge} />
      <div className="pulse-main">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="pulse-verdict">{verdict}</h1>
        <p className="pulse-story">{story}</p>
        {actions && <div className="row pulse-actions">{actions}</div>}
      </div>
      <dl className="pulse-stats">
        {stats.map((s) => (
          <div key={s.label}>
            <dt>{s.label}{s.hint && <Hint text={s.hint} />}</dt>
            <dd>{s.value}</dd>
            {s.sub && <dd className="pulse-sub">{s.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

export function verdictFor(attainment: number | null): string {
  if (attainment === null) return "No target set for this period";
  if (attainment >= 1) return "Target reached";
  if (attainment >= 0.9) return "Nearly on target";
  if (attainment >= 0.6) return "Behind target";
  return "Well behind target";
}
