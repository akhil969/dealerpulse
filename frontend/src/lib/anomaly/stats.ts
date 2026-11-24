/**
 * Statistics used by the anomaly detector. Pure functions, no imports, so this file
 * runs directly under `node --test` (see stats.test.ts). Formulas and sources are in
 * ANOMALY_DETECTION.md at the repo root.
 */

// ---------- Descriptive ----------

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n − 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Quantile by the NIST e-Handbook rule: position p(n+1) in the sorted data, interpolated. */
export function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(Math.max(p * (s.length + 1), 1), s.length);
  const lo = Math.floor(pos);
  return s[lo - 1] + (pos - lo) * ((s[lo] ?? s[lo - 1]) - s[lo - 1]);
}

/** Median absolute deviation. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

// ---------- Robust outlier scores ----------

/**
 * Modified z-score (Iglewicz & Hoaglin): M = 0.6745 (x − median) / MAD. |M| > 3.5 is a potential outlier.
 * When MAD is 0 (more than half the values are identical) the mean absolute deviation is used instead:
 * M = (x − median) / (1.253314 · MeanAD).
 */
export function modifiedZ(xs: number[]): number[] {
  const m = median(xs);
  const d = mad(xs);
  if (d > 0) return xs.map((x) => (0.6745 * (x - m)) / d);
  const meanAd = mean(xs.map((x) => Math.abs(x - m)));
  return meanAd > 0 ? xs.map((x) => (x - m) / (1.253314 * meanAd)) : xs.map(() => 0);
}

export interface Fences {
  q1: number;
  q3: number;
  iqr: number;
  innerLow: number;
  innerHigh: number;
  outerLow: number;
  outerHigh: number;
}

/** Tukey box-plot fences: inner = Q1 − 1.5·IQR, Q3 + 1.5·IQR; outer uses 3·IQR. */
export function tukeyFences(xs: number[]): Fences {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, innerLow: q1 - 1.5 * iqr, innerHigh: q3 + 1.5 * iqr, outerLow: q1 - 3 * iqr, outerHigh: q3 + 3 * iqr };
}

/** 0 = inside, 1 = beyond an inner fence (mild), 2 = beyond an outer fence (extreme). */
export function fenceLevel(x: number, f: Fences): 0 | 1 | 2 {
  if (x < f.outerLow || x > f.outerHigh) return 2;
  if (x < f.innerLow || x > f.innerHigh) return 1;
  return 0;
}

// ---------- Distributions ----------

/** Standard normal CDF via erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export const twoSidedP = (z: number) => Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));

/** ln Γ(x), Lanczos approximation (g = 7, 9 terms). */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x): series below a + 1, continued fraction above (Numerical Recipes §6.2). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lnPre = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  // Lentz's method for the continued fraction of Q(a, x).
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * h);
}

export const gammaQ = (a: number, x: number) => 1 - gammaP(a, x);

/** Upper tail of the χ² distribution with k degrees of freedom. */
export const chi2Sf = (x: number, k: number) => (x <= 0 ? 1 : gammaQ(k / 2, x / 2));

/** P(X ≤ k) for X ~ Poisson(λ) = Q(k + 1, λ). */
export const poissonCdf = (k: number, lambda: number) => (k < 0 ? 0 : gammaQ(k + 1, lambda));

/** P(X ≥ k) for X ~ Poisson(λ) = P(k, λ). */
export const poissonSf = (k: number, lambda: number) => (k <= 0 ? 1 : gammaP(k, lambda));

/** Exact two-sided Poisson test of an observed count against expected λ (doubling the smaller tail). */
export function poissonTest(k: number, lambda: number): { p: number; direction: "low" | "high" } {
  const lo = poissonCdf(k, lambda);
  const hi = poissonSf(k, lambda);
  return { p: Math.min(1, 2 * Math.min(lo, hi)), direction: k < lambda ? "low" : "high" };
}

// ---------- Proportions ----------

/** Two-proportion z-test with pooled variance. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } {
  if (n1 <= 0 || n2 <= 0) return { z: 0, p: 1 }; // nothing to compare against
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (x1 / n1 - x2 / n2) / se;
  return { z, p: twoSidedP(z) };
}

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilson(x: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const ph = x / n;
  const denom = 1 + (z * z) / n;
  const centre = ph + (z * z) / (2 * n);
  const half = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

/** Pearson χ² goodness of fit of observed counts against expected counts. */
export function chi2Gof(observed: number[], expected: number[]): { chi2: number; df: number; p: number; residuals: number[] } {
  let chi2 = 0;
  const residuals = observed.map((o, i) => {
    const e = expected[i];
    if (e <= 0) return 0;
    chi2 += (o - e) ** 2 / e;
    return (o - e) / Math.sqrt(e);
  });
  const df = expected.filter((e) => e > 0).length - 1;
  return { chi2, df, p: df > 0 ? chi2Sf(chi2, df) : 1, residuals };
}

/** Pearson χ² test of independence on an r × c table, expected E_ij = r_i c_j / n. */
export function chi2Independence(table: number[][]): { chi2: number; df: number; p: number } {
  const rows = table.map((r) => r.reduce((a, b) => a + b, 0));
  const cols = table[0].map((_, j) => table.reduce((a, r) => a + r[j], 0));
  const n = rows.reduce((a, b) => a + b, 0);
  let chi2 = 0;
  table.forEach((r, i) => r.forEach((o, j) => {
    const e = (rows[i] * cols[j]) / n;
    if (e > 0) chi2 += (o - e) ** 2 / e;
  }));
  const df = (rows.filter(Boolean).length - 1) * (cols.filter(Boolean).length - 1);
  return { chi2, df, p: chi2Sf(chi2, df) };
}

// ---------- Control charts ----------

/** Process σ for an individuals chart: average moving range / d2, d2 = 1.128 for ranges of 2. */
export function sigmaFromMovingRange(ys: number[]): number {
  if (ys.length < 2) return 0;
  const mr = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
  return mean(mr) / 1.128;
}

export interface EwmaPoint {
  y: number;
  z: number;
  ucl: number;
  lcl: number;
  out: boolean;
}

/**
 * EWMA chart: z_t = λ y_t + (1 − λ) z_{t−1}, z_0 = μ0. Exact time-varying limits
 * μ0 ± L σ √(λ/(2−λ) · (1 − (1−λ)^{2t})), which tend to NIST's asymptotic √(λ/(2−λ)) form.
 */
export function ewma(ys: number[], mu0: number, sigma: number, lambda = 0.3, L = 3): EwmaPoint[] {
  let z = mu0;
  return ys.map((y, i) => {
    z = lambda * y + (1 - lambda) * z;
    const w = L * sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - (1 - lambda) ** (2 * (i + 1))));
    return { y, z, ucl: mu0 + w, lcl: mu0 - w, out: z > mu0 + w || z < mu0 - w };
  });
}

export interface CusumPoint {
  y: number;
  hi: number;
  lo: number;
  signal: "high" | "low" | null;
}

/**
 * Tabular CUSUM in σ units: C⁺_t = max(0, C⁺_{t−1} + (y_t − μ0)/σ − k), C⁻_t = max(0, C⁻_{t−1} − (y_t − μ0)/σ − k).
 * Signals when either sum exceeds h. k = 0.5, h = 4 gives an in-control average run length of about 336 (NIST).
 */
export function cusum(ys: number[], mu0: number, sigma: number, k = 0.5, h = 4): CusumPoint[] {
  let hi = 0, lo = 0;
  return ys.map((y) => {
    const s = sigma ? (y - mu0) / sigma : 0;
    hi = Math.max(0, hi + s - k);
    lo = Math.max(0, lo - s - k);
    return { y, hi, lo, signal: hi > h ? "high" : lo > h ? "low" : null };
  });
}

// ---------- Multivariate ----------

/** Sample covariance matrix (n − 1) of row vectors. */
export function covariance(rows: number[][]): { mu: number[]; cov: number[][] } {
  const n = rows.length, p = rows[0].length;
  const mu = Array.from({ length: p }, (_, j) => mean(rows.map((r) => r[j])));
  const cov = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) =>
    rows.reduce((a, r) => a + (r[i] - mu[i]) * (r[j] - mu[j]), 0) / (n - 1)));
  return { mu, cov };
}

/** Gauss–Jordan inverse with partial pivoting. Returns null for a (near-)singular matrix. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((r) => r.slice(n));
}

/** Squared Mahalanobis distance d² = (x − μ)ᵀ Σ⁻¹ (x − μ). */
export function mahalanobis2(x: number[], mu: number[], inv: number[][]): number {
  const d = x.map((v, i) => v - mu[i]);
  return d.reduce((acc, di, i) => acc + di * inv[i].reduce((s, v, j) => s + v * d[j], 0), 0);
}

// ---------- Multiple testing ----------

/** Benjamini–Hochberg adjusted p-values (q-values), returned in the input order. */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, i] = order[r];
    running = Math.min(running, (p * m) / (r + 1));
    q[i] = Math.min(1, running);
  }
  return q;
}
