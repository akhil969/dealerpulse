"""Statistics for anomaly detection. Pure functions, standard library only.

Port of frontend/src/lib/anomaly/stats.ts; formulas and sources are in ANOMALY_DETECTION.md.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Sequence


# ---------- Descriptive ----------

def mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs)


def sd(xs: Sequence[float]) -> float:
    """Sample standard deviation (n - 1)."""
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def median(xs: Sequence[float]) -> float:
    s = sorted(xs)
    h = len(s) // 2
    return s[h] if len(s) % 2 else (s[h - 1] + s[h]) / 2


def quantile(xs: Sequence[float], p: float) -> float:
    """NIST e-Handbook rule: position p(n+1) in the sorted data, linearly interpolated."""
    s = sorted(xs)
    pos = min(max(p * (len(s) + 1), 1), len(s))
    lo = math.floor(pos)
    upper = s[lo] if lo < len(s) else s[lo - 1]
    return s[lo - 1] + (pos - lo) * (upper - s[lo - 1])


def mad(xs: Sequence[float]) -> float:
    m = median(xs)
    return median([abs(x - m) for x in xs])


# ---------- Robust outlier scores ----------

def modified_z(xs: Sequence[float]) -> list[float]:
    """Iglewicz & Hoaglin: M = 0.6745 (x - median) / MAD; mean-absolute-deviation fallback when MAD = 0."""
    m = median(xs)
    d = mad(xs)
    if d > 0:
        return [0.6745 * (x - m) / d for x in xs]
    mean_ad = mean([abs(x - m) for x in xs])
    return [(x - m) / (1.253314 * mean_ad) for x in xs] if mean_ad > 0 else [0.0 for _ in xs]


@dataclass(frozen=True)
class Fences:
    q1: float
    q3: float
    iqr: float
    inner_low: float
    inner_high: float
    outer_low: float
    outer_high: float


def tukey_fences(xs: Sequence[float]) -> Fences:
    q1, q3 = quantile(xs, 0.25), quantile(xs, 0.75)
    iqr = q3 - q1
    return Fences(q1, q3, iqr, q1 - 1.5 * iqr, q3 + 1.5 * iqr, q1 - 3 * iqr, q3 + 3 * iqr)


def fence_level(x: float, f: Fences) -> int:
    """0 inside, 1 beyond an inner fence (mild), 2 beyond an outer fence (extreme)."""
    if x < f.outer_low or x > f.outer_high:
        return 2
    if x < f.inner_low or x > f.inner_high:
        return 1
    return 0


# ---------- Distributions ----------

def normal_cdf(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def two_sided_p(z: float) -> float:
    return min(1.0, 2 * (1 - normal_cdf(abs(z))))


def gamma_p(a: float, x: float) -> float:
    """Regularised lower incomplete gamma P(a, x) (Numerical Recipes 6.2)."""
    if x <= 0:
        return 0.0
    ln_pre = -x + a * math.log(x) - math.lgamma(a)
    if x < a + 1:
        total = term = 1 / a
        for n in range(1, 500):
            term *= x / (a + n)
            total += term
            if abs(term) < abs(total) * 1e-15:
                break
        return min(1.0, total * math.exp(ln_pre))
    tiny = 1e-300
    b = x + 1 - a
    c, d = 1 / tiny, 1 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = tiny if abs(d) < tiny else d
        c = b + an / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-15:
            break
    return max(0.0, 1 - math.exp(ln_pre) * h)


def gamma_q(a: float, x: float) -> float:
    return 1 - gamma_p(a, x)


def chi2_sf(x: float, k: float) -> float:
    return 1.0 if x <= 0 else gamma_q(k / 2, x / 2)


def poisson_cdf(k: int, lam: float) -> float:
    return 0.0 if k < 0 else gamma_q(k + 1, lam)


def poisson_sf(k: int, lam: float) -> float:
    return 1.0 if k <= 0 else gamma_p(k, lam)


def poisson_test(k: int, lam: float) -> tuple[float, Literal["low", "high"]]:
    p = min(1.0, 2 * min(poisson_cdf(k, lam), poisson_sf(k, lam)))
    return p, ("low" if k < lam else "high")


# ---------- Proportions ----------

def two_proportion_z(x1: int, n1: int, x2: int, n2: int) -> tuple[float, float]:
    if n1 <= 0 or n2 <= 0:
        return 0.0, 1.0
    p = (x1 + x2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if not se:
        return 0.0, 1.0
    z = (x1 / n1 - x2 / n2) / se
    return z, two_sided_p(z)


def wilson(x: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    ph = x / n
    denom = 1 + z * z / n
    centre = ph + z * z / (2 * n)
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return max(0.0, (centre - half) / denom), min(1.0, (centre + half) / denom)


def chi2_gof(observed: Sequence[float], expected: Sequence[float]) -> tuple[float, int, float, list[float]]:
    chi2 = 0.0
    residuals = []
    for o, e in zip(observed, expected):
        if e <= 0:
            residuals.append(0.0)
            continue
        chi2 += (o - e) ** 2 / e
        residuals.append((o - e) / math.sqrt(e))
    df = sum(1 for e in expected if e > 0) - 1
    return chi2, df, (chi2_sf(chi2, df) if df > 0 else 1.0), residuals


def chi2_independence(table: Sequence[Sequence[float]]) -> tuple[float, int, float]:
    rows = [sum(r) for r in table]
    cols = [sum(r[j] for r in table) for j in range(len(table[0]))]
    n = sum(rows)
    chi2 = 0.0
    for i, r in enumerate(table):
        for j, o in enumerate(r):
            e = rows[i] * cols[j] / n
            if e > 0:
                chi2 += (o - e) ** 2 / e
    df = (sum(1 for r in rows if r) - 1) * (sum(1 for c in cols if c) - 1)
    return chi2, df, chi2_sf(chi2, df)


# ---------- Control charts ----------

def sigma_from_moving_range(ys: Sequence[float]) -> float:
    if len(ys) < 2:
        return 0.0
    return mean([abs(ys[i] - ys[i - 1]) for i in range(1, len(ys))]) / 1.128


@dataclass(frozen=True)
class EwmaPoint:
    y: float
    z: float
    ucl: float
    lcl: float
    out: bool


def ewma(ys: Sequence[float], mu0: float, sigma: float, lam: float = 0.3, L: float = 3) -> list[EwmaPoint]:
    z = mu0
    out = []
    for i, y in enumerate(ys):
        z = lam * y + (1 - lam) * z
        w = L * sigma * math.sqrt(lam / (2 - lam) * (1 - (1 - lam) ** (2 * (i + 1))))
        out.append(EwmaPoint(y, z, mu0 + w, mu0 - w, z > mu0 + w or z < mu0 - w))
    return out


@dataclass(frozen=True)
class CusumPoint:
    y: float
    hi: float
    lo: float
    signal: Literal["high", "low"] | None


def cusum(ys: Sequence[float], mu0: float, sigma: float, k: float = 0.5, h: float = 4) -> list[CusumPoint]:
    hi = lo = 0.0
    out = []
    for y in ys:
        s = (y - mu0) / sigma if sigma else 0.0
        hi = max(0.0, hi + s - k)
        lo = max(0.0, lo - s - k)
        out.append(CusumPoint(y, hi, lo, "high" if hi > h else "low" if lo > h else None))
    return out


# ---------- Multivariate ----------

def covariance(rows: Sequence[Sequence[float]]) -> tuple[list[float], list[list[float]]]:
    n, p = len(rows), len(rows[0])
    mu = [mean([r[j] for r in rows]) for j in range(p)]
    cov = [[sum((r[i] - mu[i]) * (r[j] - mu[j]) for r in rows) / (n - 1) for j in range(p)] for i in range(p)]
    return mu, cov


def invert(m: Sequence[Sequence[float]]) -> list[list[float]] | None:
    """Gauss-Jordan with partial pivoting; None when (near-)singular."""
    n = len(m)
    a = [list(r) + [1.0 if i == j else 0.0 for j in range(n)] for i, r in enumerate(m)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(a[r][c]))
        if abs(a[piv][c]) < 1e-12:
            return None
        a[c], a[piv] = a[piv], a[c]
        d = a[c][c]
        a[c] = [v / d for v in a[c]]
        for r in range(n):
            if r != c:
                f = a[r][c]
                a[r] = [v - f * w for v, w in zip(a[r], a[c])]
    return [r[n:] for r in a]


def mahalanobis2(x: Sequence[float], mu: Sequence[float], inv: Sequence[Sequence[float]]) -> float:
    d = [v - m for v, m in zip(x, mu)]
    return sum(di * sum(inv[i][j] * d[j] for j in range(len(d))) for i, di in enumerate(d))


# ---------- Multiple testing ----------

def benjamini_hochberg(ps: Sequence[float]) -> list[float]:
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    q = [1.0] * m
    running = 1.0
    for rank in range(m - 1, -1, -1):
        i = order[rank]
        running = min(running, ps[i] * m / (rank + 1))
        q[i] = min(1.0, running)
    return q
