// Run with: npm test   (Node's built-in runner; expected values come from the cited references)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  benjaminiHochberg, chi2Independence, chi2Sf, covariance, cusum, ewma, fenceLevel, invert, mahalanobis2,
  median, modifiedZ, normalCdf, poissonCdf, poissonTest, quantile, sigmaFromMovingRange, tukeyFences, twoProportionZ, wilson,
} from "./stats.ts";

const near = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b} (±${tol})`);

// NIST e-Handbook 7.1.6 example data (N = 90).
const NIST_90 = [30, 171, 184, 201, 212, 250, 265, 270, 272, 289, 305, 306, 322, 322, 336, 346, 351, 370, 390, 404, 409, 411,
  436, 437, 439, 441, 444, 448, 451, 453, 470, 480, 482, 487, 494, 495, 499, 503, 514, 521, 522, 527, 548, 550, 559, 560, 570,
  572, 574, 578, 585, 592, 592, 607, 616, 618, 621, 629, 637, 638, 640, 656, 668, 707, 709, 719, 737, 739, 752, 758, 766, 792,
  792, 794, 802, 818, 830, 832, 843, 858, 860, 869, 918, 925, 953, 991, 1000, 1005, 1068, 1441];

test("quantiles and Tukey fences match NIST 7.1.6", () => {
  near(median(NIST_90), 559.5);
  near(quantile(NIST_90, 0.25), 429.75);
  near(quantile(NIST_90, 0.75), 742.25);
  const f = tukeyFences(NIST_90);
  near(f.innerLow, -39.0);
  near(f.innerHigh, 1211.0);
  near(f.outerHigh, 1679.75);
  assert.equal(fenceLevel(1441, f), 1); // the one mild outlier
  assert.equal(NIST_90.filter((x) => fenceLevel(x, f) > 0).length, 1);
});

test("modified z-score (Iglewicz & Hoaglin)", () => {
  const m = modifiedZ([1, 2, 3, 4, 100]); // median 3, MAD 1
  near(m[4], 0.6745 * 97);
  near(m[2], 0);
  assert.ok(Math.abs(m[0]) < 3.5);
});

test("EWMA matches NIST 6.3.2.4 example", () => {
  const ys = [52.0, 47.0, 53.0, 49.3, 50.1, 47.0, 51.0, 50.1, 51.2, 50.5, 49.6, 47.6, 49.9, 51.3, 47.8, 51.2, 52.6, 52.4, 53.6, 52.1];
  const out = ewma(ys, 50, 2.0539, 0.3, 3);
  const nist = [50.60, 49.52, 50.56, 50.18, 50.16, 49.21, 49.75, 49.85, 50.26, 50.33, 50.11, 49.36, 49.52, 50.05, 49.38, 49.92, 50.73, 51.23, 51.94, 51.99];
  out.forEach((p, i) => near(p.z, nist[i], 0.006));
  near(out[19].ucl, 52.5884, 0.001); // exact limits converge to NIST's asymptotic limit
  assert.equal(out.filter((p) => p.out).length, 0);
});

test("chi-square independence matches NIST 7.4.5 wafer example", () => {
  const r = chi2Independence([[15, 21, 45, 13], [26, 31, 34, 5], [33, 17, 49, 20]]);
  near(r.chi2, 19.18, 0.01);
  assert.equal(r.df, 6);
  near(r.p, 0.00387, 0.0001);
  near(chi2Sf(3.841459, 1), 0.05, 1e-5);
});

test("normal, Poisson and proportions", () => {
  near(normalCdf(1.959964), 0.975, 1e-6);
  near(normalCdf(-1), 0.158655, 1e-6);
  near(poissonCdf(2, 1), Math.exp(-1) * 2.5, 1e-9);
  assert.ok(poissonTest(2, 12).p < 0.01);
  assert.ok(poissonTest(12, 12).p > 0.5);
  const t = twoProportionZ(45, 100, 30, 100);
  near(t.z, 2.191, 0.001);
  assert.deepEqual(twoProportionZ(5, 10, 0, 0), { z: 0, p: 1 }); // no comparison group
  const [lo, hi] = wilson(8, 10);
  near(lo, 0.4902, 1e-4);
  near(hi, 0.9433, 1e-4);
});

test("CUSUM signals a sustained small shift, not noise", () => {
  const steady = cusum([10, 11, 9, 10, 10, 11, 9], 10, 1);
  assert.ok(steady.every((p) => p.signal === null));
  const shifted = cusum([10, 10, 11.5, 11.5, 11.5, 11.5, 11.5, 11.5], 10, 1);
  assert.equal(shifted.at(-1)?.signal, "high");
  near(sigmaFromMovingRange([1, 3, 1, 3]), 2 / 1.128);
});

test("Mahalanobis distance and matrix inverse", () => {
  const inv = invert([[4, 7], [2, 6]])!;
  near(inv[0][0], 0.6); near(inv[0][1], -0.7); near(inv[1][0], -0.2); near(inv[1][1], 0.4);
  assert.equal(invert([[1, 2], [2, 4]]), null);
  near(mahalanobis2([3, 4], [0, 0], [[1, 0], [0, 1]]), 25);
  const { mu, cov } = covariance([[1, 2], [3, 6], [5, 10]]);
  assert.deepEqual(mu, [3, 6]);
  near(cov[0][1], 8);
});

test("Benjamini–Hochberg q-values", () => {
  const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
  [0.02, 0.04, 0.04, 0.02].forEach((v, i) => near(q[i], v, 1e-12));
});
