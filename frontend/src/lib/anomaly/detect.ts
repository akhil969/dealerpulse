import type { EnrichedLead, Model } from "../analytics";
import { inr, monthLabel, pct, STATUS_LABEL } from "../format";
import { FUNNEL_STAGES, OPEN_STATUSES } from "../types";
import {
  benjaminiHochberg, chi2Gof, chi2Sf, covariance, cusum, ewma, fenceLevel, invert, mahalanobis2, median, modifiedZ,
  poissonTest, sd, sigmaFromMovingRange, tukeyFences, twoProportionZ, wilson,
} from "./stats";

/** Every threshold in one place; documented in ANOMALY_DETECTION.md §3. */
export const SETTINGS = {
  fdr: 0.05,            // Benjamini–Hochberg false discovery rate for p-value tests
  modZ: 3.5,            // Iglewicz & Hoaglin cut-off
  minClosed: 8,         // fewest finished enquiries before a rep's rate is tested
  minGroup: 8,          // fewest values before a robust score is computed
  ewmaLambda: 0.3,
  ewmaL: 3,
  cusumK: 0.5,
  cusumH: 4,
  shewhartL: 3,
  highP: 0.001,         // p (or q) below this alone counts as strong evidence
} as const;

export type Category = "sales" | "team" | "delivery" | "data";
export type Direction = "low" | "high" | "inconsistent";
export type MethodId =
  | "two-proportion" | "modified-z" | "tukey" | "poisson" | "ewma" | "cusum" | "shewhart" | "chi-square" | "mahalanobis" | "consistency";

export const METHOD_LABEL: Record<MethodId, string> = {
  "two-proportion": "Two-proportion z-test",
  "modified-z": "Modified z-score (median and MAD)",
  tukey: "Tukey box-plot fences",
  poisson: "Exact Poisson count test",
  ewma: "EWMA control chart",
  cusum: "CUSUM control chart",
  shewhart: "Shewhart 3-sigma limit",
  "chi-square": "Chi-square goodness of fit",
  mahalanobis: "Mahalanobis distance",
  consistency: "Consistency check",
};

export interface Evidence {
  method: MethodId;
  /** e.g. "z = −3.41" */
  statistic: string;
  /** e.g. "|z| beyond what chance explains" */
  rule: string;
  p?: number;
  q?: number;
  strong: boolean;
}

export interface SeriesPoint {
  label: string;
  value: number;
  flagged?: boolean;
}

export interface Anomaly {
  id: string;
  category: Category;
  direction: Direction;
  title: string;
  summary: string;
  observed: string;
  expected: string;
  branchId?: string;
  repId?: string;
  leadIds?: string[];
  evidence: Evidence[];
  confidence: "high" | "medium";
  /** Sort key: larger is more unusual. */
  score: number;
  series?: { points: SeriesPoint[]; centre: number; lo: number; hi: number };
  href?: string;
}

type Draft = Omit<Anomaly, "confidence" | "score">;

const fmtP = (p: number) => (p < 0.0001 ? "< 0.0001" : p.toFixed(4));
const sign = (x: number) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(2);
const isClosed = (l: EnrichedLead) => l.status === "lost" || l.maxStage >= 4;
const won = (l: EnrichedLead) => l.maxStage >= 4;

/** Collects drafts, merging findings about the same thing that several methods agree on. */
class Findings {
  private map = new Map<string, Draft>();
  add(d: Draft) {
    const prev = this.map.get(d.id);
    if (!prev) this.map.set(d.id, d);
    else prev.evidence.push(...d.evidence.filter((e) => !prev.evidence.some((x) => x.method === e.method)));
  }
  /** Add evidence only if a finding already exists for this id (corroboration, not a new flag). */
  corroborate(id: string, e: Evidence) {
    const prev = this.map.get(id);
    if (prev && !prev.evidence.some((x) => x.method === e.method)) prev.evidence.push(e);
  }
  list(): Anomaly[] {
    return [...this.map.values()].map((d) => {
      const ps = d.evidence.map((e) => e.q ?? e.p).filter((p): p is number => p !== undefined);
      const minP = ps.length ? Math.min(...ps) : 1;
      const methods = new Set(d.evidence.map((e) => e.method)).size;
      const strong = d.evidence.some((e) => e.strong);
      const confidence: Anomaly["confidence"] = d.direction === "inconsistent" || methods >= 2 || strong ? "high" : "medium";
      const score = (confidence === "high" ? 100 : 0) + methods * 10 + Math.min(40, -Math.log10(Math.max(minP, 1e-40)));
      return { ...d, confidence, score };
    }).sort((a, b) => b.score - a.score);
  }
}

/** Run every detector over the full dataset. Deterministic: the same data gives the same ids. */
export function detectAnomalies(m: Model): Anomaly[] {
  const f = new Findings();
  conversionVsPeers(m, f);
  funnelSteps(m, f);
  replySpeed(m, f);
  deliveryTimes(m, f);
  priceOutliers(m, f);
  monthlyVolumes(m, f);
  lossReasons(m, f);
  repProfiles(m, f);
  consistency(m, f);
  return f.list();
}

// ---------- 1. Conversion against peers (two-proportion z + BH, corroborated by modified z) ----------

function conversionVsPeers(m: Model, f: Findings) {
  const closed = m.leads.filter(isClosed);
  const groups: { kind: "rep" | "branch"; id: string; name: string; branchId: string; x: number; n: number }[] = [];
  for (const r of m.reps) {
    const ls = closed.filter((l) => l.assigned_to === r.id);
    if (ls.length >= SETTINGS.minClosed) groups.push({ kind: "rep", id: r.id, name: r.name, branchId: r.branch_id, x: ls.filter(won).length, n: ls.length });
  }
  for (const b of m.branches) {
    const ls = closed.filter((l) => l.branch_id === b.id);
    if (ls.length) groups.push({ kind: "branch", id: b.id, name: b.name, branchId: b.id, x: ls.filter(won).length, n: ls.length });
  }
  const X = closed.filter(won).length, N = closed.length;

  for (const kind of ["rep", "branch"] as const) {
    const gs = groups.filter((g) => g.kind === kind);
    const tests = gs.map((g) => twoProportionZ(g.x, g.n, X - g.x, N - g.n));
    const qs = benjaminiHochberg(tests.map((t) => t.p));
    const mz = modifiedZ(gs.map((g) => g.x / g.n));
    gs.forEach((g, i) => {
      const { z, p } = tests[i];
      const rate = g.x / g.n, rest = (X - g.x) / (N - g.n);
      const [lo, hi] = wilson(g.x, g.n);
      const id = `conversion:${kind}:${g.id}`;
      const low = z < 0;
      const draft = (ev: Evidence): Draft => ({
        id, category: kind === "rep" ? "team" : "sales", direction: low ? "low" : "high",
        title: low ? `${g.name} turns far fewer enquiries into orders than everyone else` : `${g.name} turns far more enquiries into orders than everyone else`,
        summary: `${pct(rate)} of ${kind === "rep" ? "their" : "its"} finished enquiries became orders, against ${pct(rest)} for the rest of the network. A gap this size is unlikely to be bad luck.${low ? "" : " Worth finding out what they do differently."}`,
        observed: `${pct(rate)} (${g.x} of ${g.n} finished enquiries, likely range ${pct(lo)}–${pct(hi)})`,
        expected: `${pct(rest)} (everyone else)`,
        branchId: g.branchId, repId: kind === "rep" ? g.id : undefined, evidence: [ev],
        href: kind === "rep" ? `/dashboard/rep/${g.id}` : `/dashboard/branch/${g.id}`,
      });
      if (qs[i] < SETTINGS.fdr) {
        f.add(draft({ method: "two-proportion", statistic: `z = ${sign(z)}`, rule: `q < ${SETTINGS.fdr} after Benjamini–Hochberg`, p, q: qs[i], strong: qs[i] < SETTINGS.highP }));
      }
      if (gs.length >= SETTINGS.minGroup && Math.abs(mz[i]) > SETTINGS.modZ) {
        const e: Evidence = { method: "modified-z", statistic: `M = ${sign(mz[i])}`, rule: `|M| > ${SETTINGS.modZ}`, strong: Math.abs(mz[i]) > 2 * SETTINGS.modZ };
        if (qs[i] < SETTINGS.fdr) f.corroborate(id, e);
        else f.add(draft(e));
      }
    });
  }
}

// ---------- 2. Funnel step rates by branch (two-proportion z + BH) ----------

function funnelSteps(m: Model, f: Findings) {
  type Cell = { branch: string; step: number; x: number; n: number };
  const cells: Cell[] = [];
  // A lead "finished" step s−1 if it moved on or was lost there; leads still sitting at s−1 are excluded.
  const finishedAt = (l: EnrichedLead, s: number) => l.maxStage >= s || (l.maxStage === s - 1 && l.status === "lost");
  for (const b of m.branches) {
    for (let s = 1; s < FUNNEL_STAGES.length; s++) {
      const ls = m.leads.filter((l) => l.branch_id === b.id && l.maxStage >= s - 1 && finishedAt(l, s));
      cells.push({ branch: b.id, step: s, x: ls.filter((l) => l.maxStage >= s).length, n: ls.length });
    }
  }
  const tests = cells.map((c) => {
    const others = cells.filter((o) => o.step === c.step && o.branch !== c.branch);
    const x2 = others.reduce((a, o) => a + o.x, 0), n2 = others.reduce((a, o) => a + o.n, 0);
    return { ...twoProportionZ(c.x, c.n, x2, n2), rest: n2 ? x2 / n2 : 0 };
  });
  const qs = benjaminiHochberg(tests.map((t) => t.p));
  cells.forEach((c, i) => {
    if (!(qs[i] < SETTINGS.fdr) || c.n < SETTINGS.minClosed) return;
    const { z, p, rest } = tests[i];
    const b = m.branchById.get(c.branch)!;
    const from = STATUS_LABEL[FUNNEL_STAGES[c.step - 1]].toLowerCase(), to = STATUS_LABEL[FUNNEL_STAGES[c.step]].toLowerCase();
    const low = z < 0;
    f.add({
      id: `funnel:${c.branch}:${FUNNEL_STAGES[c.step]}`, category: "sales", direction: low ? "low" : "high",
      title: `${b.name}: ${low ? "unusually few" : "unusually many"} customers get from ${from} to ${to}`,
      summary: `${pct(c.x / c.n)} make this step at ${b.name}, against ${pct(rest)} at the other branches.`,
      observed: `${pct(c.x / c.n)} (${c.x} of ${c.n})`, expected: `${pct(rest)} at other branches`,
      branchId: c.branch, href: `/dashboard/funnel?branch=${c.branch}`,
      evidence: [{ method: "two-proportion", statistic: `z = ${sign(z)}`, rule: `q < ${SETTINGS.fdr} after Benjamini–Hochberg`, p, q: qs[i], strong: qs[i] < SETTINGS.highP }],
    });
  });
}

// ---------- 3. First reply speed by rep (modified z, corroborated by Tukey) ----------

function replySpeed(m: Model, f: Findings) {
  const reps = m.reps.map((r) => {
    const hs = m.leads.filter((l) => l.assigned_to === r.id && l.firstContactHours !== null).map((l) => l.firstContactHours!);
    return { r, n: hs.length, h: hs.length ? median(hs) : 0 };
  }).filter((x) => x.n >= 5);
  if (reps.length < SETTINGS.minGroup) return;
  const vals = reps.map((x) => x.h);
  const mz = modifiedZ(vals), fences = tukeyFences(vals), typical = median(vals);
  reps.forEach(({ r, n, h }, i) => {
    const level = fenceLevel(h, fences);
    if (Math.abs(mz[i]) <= SETTINGS.modZ && level === 0) return;
    const slow = h > typical;
    const evidence: Evidence[] = [];
    if (Math.abs(mz[i]) > SETTINGS.modZ) evidence.push({ method: "modified-z", statistic: `M = ${sign(mz[i])}`, rule: `|M| > ${SETTINGS.modZ}`, strong: Math.abs(mz[i]) > 2 * SETTINGS.modZ });
    if (level) evidence.push({ method: "tukey", statistic: `${h.toFixed(0)} h vs fences ${fences.innerLow.toFixed(0)}–${fences.innerHigh.toFixed(0)} h`, rule: level === 2 ? "beyond the outer fence (3 × IQR)" : "beyond the inner fence (1.5 × IQR)", strong: level === 2 });
    f.add({
      id: `reply:rep:${r.id}`, category: "team", direction: slow ? "high" : "low",
      title: slow ? `${r.name} takes unusually long to reply to new enquiries` : `${r.name} replies to new enquiries unusually fast`,
      summary: `Their typical first reply takes ${h.toFixed(0)} hours. Most of the team replies in about ${typical.toFixed(0)} hours.`,
      observed: `${h.toFixed(0)} h median (${n} enquiries)`, expected: `${typical.toFixed(0)} h team median`,
      branchId: r.branch_id, repId: r.id, href: `/dashboard/rep/${r.id}`, evidence,
    });
  });
}

// ---------- 4. Delivery times (Tukey fences, corroborated by modified z) ----------

function deliveryTimes(m: Model, f: Findings) {
  const ls = m.leads.filter((l) => l.delivery);
  if (ls.length < SETTINGS.minGroup) return;
  const days = ls.map((l) => l.delivery!.days_to_deliver);
  const fences = tukeyFences(days), mz = modifiedZ(days), typical = median(days);
  ls.forEach((l, i) => {
    const level = fenceLevel(days[i], fences);
    const zHit = Math.abs(mz[i]) > SETTINGS.modZ;
    if (!level && !zHit) return;
    const d = l.delivery!;
    const evidence: Evidence[] = [];
    if (level) evidence.push({ method: "tukey", statistic: `${days[i]} days vs fences ${fences.innerLow.toFixed(1)}–${fences.innerHigh.toFixed(1)}`, rule: level === 2 ? "beyond the outer fence (3 × IQR)" : "beyond the inner fence (1.5 × IQR)", strong: level === 2 });
    if (zHit) evidence.push({ method: "modified-z", statistic: `M = ${sign(mz[i])}`, rule: `|M| > ${SETTINGS.modZ}`, strong: false });
    const slow = days[i] > typical;
    f.add({
      id: `delivery:${l.id}`, category: "delivery", direction: slow ? "high" : "low",
      title: slow ? `${l.customer_name}'s ${l.model_interested} took unusually long to deliver` : `${l.customer_name}'s ${l.model_interested} was delivered unusually fast`,
      summary: `${days[i]} days from order to handover; most deliveries take ${typical} days.${d.delay_reason ? ` Reason given: ${d.delay_reason.toLowerCase()}.` : " No delay reason was recorded."}`,
      observed: `${days[i]} days`, expected: `${typical} days typical (middle half ${fences.q1}–${fences.q3})`,
      branchId: l.branch_id, repId: l.assigned_to, leadIds: [l.id], href: `/dashboard/rep/${l.assigned_to}`, evidence,
    });
  });
}

// ---------- 5. Price outliers within each car model (modified z + Tukey) ----------

function priceOutliers(m: Model, f: Findings) {
  const byModel = new Map<string, EnrichedLead[]>();
  m.leads.forEach((l) => byModel.set(l.model_interested, [...(byModel.get(l.model_interested) ?? []), l]));
  for (const [model, ls] of byModel) {
    if (ls.length < SETTINGS.minGroup) continue;
    const vals = ls.map((l) => l.deal_value);
    const mz = modifiedZ(vals), fences = tukeyFences(vals), typical = median(vals);
    ls.forEach((l, i) => {
      const level = fenceLevel(vals[i], fences);
      const zHit = Math.abs(mz[i]) > SETTINGS.modZ;
      if (!zHit && level < 2) return; // mild fence hits alone are normal price spread
      const evidence: Evidence[] = [];
      if (zHit) evidence.push({ method: "modified-z", statistic: `M = ${sign(mz[i])}`, rule: `|M| > ${SETTINGS.modZ}`, strong: Math.abs(mz[i]) > 2 * SETTINGS.modZ });
      if (level) evidence.push({ method: "tukey", statistic: `${inr(vals[i])} vs fences ${inr(fences.innerLow)}–${inr(fences.innerHigh)}`, rule: level === 2 ? "beyond the outer fence (3 × IQR)" : "beyond the inner fence (1.5 × IQR)", strong: level === 2 });
      f.add({
        id: `price:${l.id}`, category: "data", direction: vals[i] > typical ? "high" : "low",
        title: `Unusual deal value for a ${model}: ${inr(vals[i])}`,
        summary: `${model} deals are usually around ${inr(typical)}. This could be a typing mistake, a different variant, or a big discount.`,
        observed: inr(vals[i]), expected: `${inr(typical)} typical for a ${model}`,
        branchId: l.branch_id, repId: l.assigned_to, leadIds: [l.id], href: `/dashboard/rep/${l.assigned_to}`, evidence,
      });
    });
  }
}

// ---------- 6. Monthly enquiries and orders per branch (Poisson + EWMA + CUSUM + Shewhart) ----------

function monthlyVolumes(m: Model, f: Findings) {
  const metrics = [
    { key: "enquiries", label: "enquiries", month: (l: EnrichedLead) => l.createdMonth, skipFirst: false },
    // Orders lag enquiries by weeks and the data starts empty, so the first month is a warm-up and excluded.
    { key: "orders", label: "orders", month: (l: EnrichedLead) => l.orderMonth, skipFirst: true },
  ];
  const poissonCells: { branch: string; metric: (typeof metrics)[number]; i: number; months: string[]; ys: number[]; lambda: number; p: number; dir: "low" | "high"; series: NonNullable<Anomaly["series"]> }[] = [];

  for (const b of m.branches) {
    for (const metric of metrics) {
      const months = metric.skipFirst ? m.months.slice(1) : m.months;
      const ys = months.map((mo) => m.leads.filter((l) => l.branch_id === b.id && metric.month(l) === mo).length);
      if (ys.length < 4) continue;
      const mu0 = median(ys);
      // Counts: σ never below the Poisson standard deviation √μ, so short series don't give tiny limits.
      const sigma = Math.max(sigmaFromMovingRange(ys), Math.sqrt(Math.max(mu0, 1)));
      const ew = ewma(ys, mu0, sigma, SETTINGS.ewmaLambda, SETTINGS.ewmaL);
      const cu = cusum(ys, mu0, sigma, SETTINGS.cusumK, SETTINGS.cusumH);
      const series = {
        points: months.map((mo, i) => ({ label: monthLabel(mo, true), value: ys[i] })),
        centre: mu0, lo: Math.max(0, mu0 - SETTINGS.shewhartL * sigma), hi: mu0 + SETTINGS.shewhartL * sigma,
      };
      const base = (i: number, dir: "low" | "high"): Draft => ({
        id: `volume:${b.id}:${metric.key}:${months[i]}`, category: "sales", direction: dir,
        title: `${b.name}: ${dir === "low" ? "unusually few" : "unusually many"} ${metric.label} in ${monthLabel(months[i])}`,
        summary: `${ys[i]} ${metric.label} in ${monthLabel(months[i])}, against a typical month of about ${mu0.toFixed(0)}.`,
        observed: `${ys[i]} ${metric.label}`, expected: `about ${mu0.toFixed(0)} a month (${b.name}'s median)`,
        branchId: b.id, href: `/dashboard/branch/${b.id}`, evidence: [],
        series: { ...series, points: series.points.map((p, j) => ({ ...p, flagged: j === i })) },
      });
      ys.forEach((y, i) => {
        // Poisson against the average of the other months (leave-one-out), collected for BH below.
        const others = ys.filter((_, j) => j !== i);
        const lambda = others.reduce((a, v) => a + v, 0) / others.length;
        const t = poissonTest(y, lambda);
        poissonCells.push({ branch: b.id, metric, i, months, ys, lambda, p: t.p, dir: t.direction, series: { ...series, points: series.points.map((pt, j) => ({ ...pt, flagged: j === i })) } });
        if (Math.abs(y - mu0) > SETTINGS.shewhartL * sigma) {
          const d = base(i, y < mu0 ? "low" : "high");
          d.evidence.push({ method: "shewhart", statistic: `${y} vs limits ${series.lo.toFixed(1)}–${series.hi.toFixed(1)}`, rule: `beyond median ± ${SETTINGS.shewhartL}σ`, strong: true });
          f.add(d);
        }
        if (ew[i].out) {
          const d = base(i, ew[i].z < mu0 ? "low" : "high");
          d.evidence.push({ method: "ewma", statistic: `EWMA = ${ew[i].z.toFixed(1)} vs ${ew[i].lcl.toFixed(1)}–${ew[i].ucl.toFixed(1)}`, rule: `outside ±${SETTINGS.ewmaL}σ EWMA limits (λ = ${SETTINGS.ewmaLambda})`, strong: false });
          f.add(d);
        }
        // CUSUM: flag only the month the signal first appears, not every month after.
        if (cu[i].signal && (i === 0 || cu[i - 1].signal !== cu[i].signal)) {
          const d = base(i, cu[i].signal);
          d.title = `${b.name}: ${metric.label} have ${cu[i].signal === "low" ? "been running low" : "been running high"} since ${monthLabel(months[Math.max(0, i - 2)])}`;
          d.summary = `Month after month, ${metric.label} have stayed ${cu[i].signal === "low" ? "below" : "above"} ${b.name}'s typical ${mu0.toFixed(0)}. A sustained shift like this builds up even when no single month looks extreme.`;
          d.evidence.push({ method: "cusum", statistic: `C${cu[i].signal === "high" ? "⁺" : "⁻"} = ${(cu[i].signal === "high" ? cu[i].hi : cu[i].lo).toFixed(2)}`, rule: `cumulative sum above h = ${SETTINGS.cusumH} (k = ${SETTINGS.cusumK})`, strong: false });
          f.add(d);
        }
      });
    }
  }

  const qs = benjaminiHochberg(poissonCells.map((c) => c.p));
  poissonCells.forEach((c, k) => {
    if (!(qs[k] < SETTINGS.fdr)) return;
    const b = m.branchById.get(c.branch)!;
    const id = `volume:${c.branch}:${c.metric.key}:${c.months[c.i]}`;
    const e: Evidence = { method: "poisson", statistic: `${c.ys[c.i]} observed vs ${c.lambda.toFixed(1)} expected`, rule: `q < ${SETTINGS.fdr} after Benjamini–Hochberg`, p: c.p, q: qs[k], strong: qs[k] < SETTINGS.highP };
    f.corroborate(id, e);
    // A Poisson hit with no chart signal still deserves review.
    f.add({
      id, category: "sales", direction: c.dir,
      title: `${b.name}: ${c.dir === "low" ? "unusually few" : "unusually many"} ${c.metric.label} in ${monthLabel(c.months[c.i])}`,
      summary: `${c.ys[c.i]} ${c.metric.label}, when the other months average ${c.lambda.toFixed(1)}.`,
      observed: `${c.ys[c.i]} ${c.metric.label}`, expected: `${c.lambda.toFixed(1)} (average of the other months)`,
      branchId: c.branch, href: `/dashboard/branch/${c.branch}`, evidence: [e], series: c.series,
    });
  });
}

// ---------- 7. Why customers didn't buy, by branch (χ² goodness of fit + BH) ----------

function lossReasons(m: Model, f: Findings) {
  const lost = m.leads.filter((l) => l.status === "lost" && l.lost_reason);
  const reasons = [...new Set(lost.map((l) => l.lost_reason!))].sort();
  if (reasons.length < 2) return;
  const rows = m.branches.map((b) => reasons.map((r) => lost.filter((l) => l.branch_id === b.id && l.lost_reason === r).length));
  const results = rows.map((row, i) => {
    const n = row.reduce((a, v) => a + v, 0);
    const other = reasons.map((_, j) => rows.reduce((a, r, k) => a + (k === i ? 0 : r[j]), 0));
    const on = other.reduce((a, v) => a + v, 0);
    const expected = other.map((o) => (on ? (o / on) * n : 0));
    return { n, expected, ...chi2Gof(row, expected) };
  });
  const qs = benjaminiHochberg(results.map((r) => r.p));
  results.forEach((r, i) => {
    if (!(qs[i] < SETTINGS.fdr) || r.n < 20) return;
    const b = m.branches[i];
    const top = r.residuals.indexOf(Math.max(...r.residuals));
    f.add({
      id: `loss-mix:${b.id}`, category: "sales", direction: "high",
      title: `${b.name} loses customers for different reasons than other branches`,
      summary: `"${reasons[top]}" comes up far more often here: ${rows[i][top]} times, where about ${r.expected[top].toFixed(1)} would be normal for a branch this size.`,
      observed: `${rows[i][top]} × "${reasons[top]}"`, expected: `${r.expected[top].toFixed(1)} based on the other branches`,
      branchId: b.id, href: `/dashboard/funnel?branch=${b.id}`,
      evidence: [{ method: "chi-square", statistic: `χ² = ${r.chi2.toFixed(2)}, df = ${r.df}`, rule: `q < ${SETTINGS.fdr} after Benjamini–Hochberg`, p: r.p, q: qs[i], strong: qs[i] < SETTINGS.highP }],
    });
  });
}

// ---------- 8. Rep profile across several measures (Mahalanobis distance + BH) ----------

function repProfiles(m: Model, f: Findings) {
  const names = ["conversion", "first reply (h)", "avg deal (₹L)", "reach test drive"];
  const rows: { id: string; v: number[] }[] = [];
  for (const r of m.reps) {
    const ls = m.leads.filter((l) => l.assigned_to === r.id);
    const closed = ls.filter(isClosed);
    const hs = ls.map((l) => l.firstContactHours).filter((h): h is number => h !== null);
    if (closed.length < SETTINGS.minClosed || hs.length < 5) continue;
    rows.push({ id: r.id, v: [
      closed.filter(won).length / closed.length,
      median(hs),
      ls.reduce((a, l) => a + l.deal_value, 0) / ls.length / 1e5,
      ls.filter((l) => l.maxStage >= 2).length / ls.length,
    ] });
  }
  const p = names.length;
  if (rows.length < 3 * p) return; // need clearly more reps than measures for a stable covariance
  const { mu, cov } = covariance(rows.map((r) => r.v));
  const inv = invert(cov);
  if (!inv) return;
  const sds = names.map((_, j) => sd(rows.map((r) => r.v[j])));
  const d2 = rows.map((r) => mahalanobis2(r.v, mu, inv));
  const ps = d2.map((d) => chi2Sf(d, p));
  const qs = benjaminiHochberg(ps);
  rows.forEach((row, i) => {
    if (!(qs[i] < SETTINGS.fdr)) return;
    const rep = m.repById.get(row.id)!;
    const zs = row.v.map((v, j) => (sds[j] ? (v - mu[j]) / sds[j] : 0));
    const j = zs.map(Math.abs).indexOf(Math.max(...zs.map(Math.abs)));
    const fmt = (k: number, v: number) => (k === 0 || k === 3 ? pct(v) : k === 1 ? `${v.toFixed(0)} h` : `₹${v.toFixed(1)} L`);
    f.add({
      id: `profile:rep:${row.id}`, category: "team", direction: zs[j] < 0 ? "low" : "high",
      title: `${rep.name}'s way of selling stands out from the team`,
      summary: `Taken together, their numbers don't look like anyone else's. The biggest difference is ${names[j]}: ${fmt(j, row.v[j])} against a team average of ${fmt(j, mu[j])}.`,
      observed: names.map((n, k) => `${n} ${fmt(k, row.v[k])}`).join(" · "),
      expected: names.map((n, k) => `${n} ${fmt(k, mu[k])}`).join(" · "),
      branchId: rep.branch_id, repId: rep.id, href: `/dashboard/rep/${rep.id}`,
      evidence: [{ method: "mahalanobis", statistic: `d² = ${d2[i].toFixed(2)} on ${p} measures`, rule: `χ²(${p}) q < ${SETTINGS.fdr} after Benjamini–Hochberg`, p: ps[i], q: qs[i], strong: qs[i] < SETTINGS.highP }],
    });
  });
}

// ---------- 9. Data consistency (deterministic rules) ----------

function consistency(m: Model, f: Findings) {
  const DAY = 86_400_000;
  const checks: { key: string; title: string; summary: string; leads: EnrichedLead[] }[] = [
    {
      key: "status-history", title: "Some leads' status doesn't match their history",
      summary: "The status field says one thing but the last step in the history says another. DealerPulse follows the history; the file is not changed.",
      leads: m.leads.filter((l) => l.statusInFile !== l.status),
    },
    {
      key: "history-order", title: "Some leads have history steps out of time order",
      summary: "A later step has an earlier timestamp than the step before it.",
      leads: m.leads.filter((l) => l.status_history.some((e, i) => i > 0 && Date.parse(e.timestamp) < Date.parse(l.status_history[i - 1].timestamp))),
    },
    {
      key: "skipped-stage", title: "Some leads skipped a sales step",
      summary: "The history jumps over a step, for example from new straight to order placed.",
      leads: m.leads.filter((l) => l.status_history.some((e, i) => {
        if (i === 0) return false;
        const a = FUNNEL_STAGES.indexOf(l.status_history[i - 1].status), b = FUNNEL_STAGES.indexOf(e.status);
        return a >= 0 && b > a + 1;
      })),
    },
    {
      key: "delivery-days", title: "Some delivery records don't add up",
      summary: "The number of days to deliver doesn't match the gap between the order and delivery dates.",
      leads: m.leads.filter((l) => l.delivery && Math.abs(Math.round((Date.parse(l.delivery.delivery_date) - Date.parse(l.delivery.order_date)) / DAY) - l.delivery.days_to_deliver) > 1),
    },
    {
      key: "delivered-not-closed", title: "Some delivered cars are still shown as in progress",
      summary: "There's a delivery record, but the lead's history never reaches delivered.",
      leads: m.leads.filter((l) => l.delivery && l.status !== "delivered" && OPEN_STATUSES.includes(l.status)),
    },
  ];
  for (const c of checks) {
    if (!c.leads.length) continue;
    f.add({
      id: `data:${c.key}`, category: "data", direction: "inconsistent", title: c.title,
      summary: `${c.summary} Affects ${c.leads.length} lead${c.leads.length > 1 ? "s" : ""}: ${c.leads.slice(0, 6).map((l) => l.id).join(", ")}${c.leads.length > 6 ? "…" : ""}.`,
      observed: `${c.leads.length} of ${m.leads.length} leads`, expected: "0",
      leadIds: c.leads.map((l) => l.id),
      // A single-branch problem belongs to that branch, so its manager can review it.
      branchId: new Set(c.leads.map((l) => l.branch_id)).size === 1 ? c.leads[0].branch_id : undefined,
      evidence: [{ method: "consistency", statistic: `${c.leads.length} records`, rule: "fails a rule that should always hold", strong: true }],
    });
  }
}

export const fmtPValue = fmtP;
