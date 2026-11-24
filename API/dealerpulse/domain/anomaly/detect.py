"""Anomaly detectors. Port of frontend/src/lib/anomaly/detect.ts: same ids, thresholds and wording.

Every finding is *flagged for review*; nothing here decides that something is a problem.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from ..model import FUNNEL_STAGES, OPEN_STATUSES, STATUS_LABEL, Lead, Model, inr, month_label, pct
from . import stats as st

SETTINGS = {
    "fdr": 0.05, "mod_z": 3.5, "min_closed": 8, "min_group": 8, "ewma_lambda": 0.3, "ewma_L": 3,
    "cusum_k": 0.5, "cusum_h": 4, "shewhart_L": 3, "high_p": 0.001,
}

METHOD_LABEL = {
    "two-proportion": "Two-proportion z-test", "modified-z": "Modified z-score (median and MAD)",
    "tukey": "Tukey box-plot fences", "poisson": "Exact Poisson count test", "ewma": "EWMA control chart",
    "cusum": "CUSUM control chart", "shewhart": "Shewhart 3-sigma limit", "chi-square": "Chi-square goodness of fit",
    "mahalanobis": "Mahalanobis distance", "consistency": "Consistency check",
}


@dataclass
class Evidence:
    method: str
    statistic: str
    rule: str
    strong: bool
    p: float | None = None
    q: float | None = None


@dataclass
class Finding:
    id: str
    category: Literal["sales", "team", "delivery", "data"]
    direction: Literal["low", "high", "inconsistent"]
    title: str
    summary: str
    observed: str
    expected: str
    evidence: list[Evidence]
    branchId: str | None = None
    repId: str | None = None
    leadIds: list[str] | None = None
    href: str | None = None
    series: dict[str, Any] | None = None
    confidence: str = "medium"
    score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["evidence"] = [{k: v for k, v in asdict(e).items() if v is not None} for e in self.evidence]
        return {k: v for k, v in d.items() if v is not None}


def _sign(x: float) -> str:
    return ("−" if x < 0 else "") + f"{abs(x):.2f}"


def _closed(l: Lead) -> bool:
    return l.status == "lost" or l.max_stage >= 4


def _won(l: Lead) -> bool:
    return l.max_stage >= 4


class _Findings:
    def __init__(self) -> None:
        self.map: dict[str, Finding] = {}

    def add(self, f: Finding) -> None:
        prev = self.map.get(f.id)
        if prev is None:
            self.map[f.id] = f
            return
        have = {e.method for e in prev.evidence}
        prev.evidence.extend(e for e in f.evidence if e.method not in have)

    def corroborate(self, fid: str, e: Evidence) -> None:
        prev = self.map.get(fid)
        if prev and all(x.method != e.method for x in prev.evidence):
            prev.evidence.append(e)

    def result(self) -> list[Finding]:
        out = []
        for f in self.map.values():
            ps = [e.q if e.q is not None else e.p for e in f.evidence if (e.q if e.q is not None else e.p) is not None]
            min_p = min(ps) if ps else 1.0
            methods = len({e.method for e in f.evidence})
            strong = any(e.strong for e in f.evidence)
            f.confidence = "high" if f.direction == "inconsistent" or methods >= 2 or strong else "medium"
            f.score = (100 if f.confidence == "high" else 0) + methods * 10 + min(40.0, -math.log10(max(min_p, 1e-40)))
            out.append(f)
        return sorted(out, key=lambda f: -f.score)


def detect(m: Model) -> list[Finding]:
    f = _Findings()
    for detector in (_conversion, _funnel, _reply, _deliveries, _prices, _volumes, _loss_mix, _profiles, _consistency):
        detector(m, f)
    return f.result()


def _bh_flag(q: float) -> bool:
    return q < SETTINGS["fdr"]


# 1. Conversion against peers
def _conversion(m: Model, f: _Findings) -> None:
    closed = [l for l in m.leads if _closed(l)]
    X, N = sum(1 for l in closed if _won(l)), len(closed)
    for kind in ("rep", "branch"):
        groups = []
        if kind == "rep":
            for r in m.reps:
                ls = [l for l in closed if l.assigned_to == r["id"]]
                if len(ls) >= SETTINGS["min_closed"]:
                    groups.append((r["id"], r["name"], r["branch_id"], sum(1 for l in ls if _won(l)), len(ls)))
        else:
            for b in m.branches:
                ls = [l for l in closed if l.branch_id == b["id"]]
                if ls:
                    groups.append((b["id"], b["name"], b["id"], sum(1 for l in ls if _won(l)), len(ls)))
        if not groups:
            continue
        tests = [st.two_proportion_z(x, n, X - x, N - n) for (_, _, _, x, n) in groups]
        qs = st.benjamini_hochberg([p for _, p in tests])
        mz = st.modified_z([x / n for (*_, x, n) in groups])
        for i, (gid, name, branch_id, x, n) in enumerate(groups):
            z, p = tests[i]
            rest = (X - x) / (N - n) if N - n else 0.0
            lo, hi = st.wilson(x, n)
            fid = f"conversion:{kind}:{gid}"
            low = z < 0

            def draft(ev: Evidence) -> Finding:
                return Finding(
                    id=fid, category="team" if kind == "rep" else "sales", direction="low" if low else "high",
                    title=f"{name} turns far {'fewer' if low else 'more'} enquiries into orders than everyone else",
                    summary=f"{pct(x / n)} of {'their' if kind == 'rep' else 'its'} finished enquiries became orders, against "
                            f"{pct(rest)} for the rest of the network. A gap this size is unlikely to be bad luck."
                            + ("" if low else " Worth finding out what they do differently."),
                    observed=f"{pct(x / n)} ({x} of {n} finished enquiries, likely range {pct(lo)}–{pct(hi)})",
                    expected=f"{pct(rest)} (everyone else)", evidence=[ev], branchId=branch_id,
                    repId=gid if kind == "rep" else None,
                    href=f"/dashboard/rep/{gid}" if kind == "rep" else f"/dashboard/branch/{gid}",
                )
            if _bh_flag(qs[i]):
                f.add(draft(Evidence("two-proportion", f"z = {_sign(z)}", f"q < {SETTINGS['fdr']} after Benjamini–Hochberg",
                                     qs[i] < SETTINGS["high_p"], p, qs[i])))
            if len(groups) >= SETTINGS["min_group"] and abs(mz[i]) > SETTINGS["mod_z"]:
                ev = Evidence("modified-z", f"M = {_sign(mz[i])}", f"|M| > {SETTINGS['mod_z']}", abs(mz[i]) > 2 * SETTINGS["mod_z"])
                f.corroborate(fid, ev) if _bh_flag(qs[i]) else f.add(draft(ev))


# 2. Funnel step rates by branch
def _funnel(m: Model, f: _Findings) -> None:
    def finished_at(l: Lead, s: int) -> bool:
        return l.max_stage >= s or (l.max_stage == s - 1 and l.status == "lost")
    cells = []
    for b in m.branches:
        for s in range(1, len(FUNNEL_STAGES)):
            ls = [l for l in m.leads if l.branch_id == b["id"] and l.max_stage >= s - 1 and finished_at(l, s)]
            cells.append((b["id"], s, sum(1 for l in ls if l.max_stage >= s), len(ls)))
    if not cells:
        return
    tests = []
    for (br, s, x, n) in cells:
        x2 = sum(c[2] for c in cells if c[1] == s and c[0] != br)
        n2 = sum(c[3] for c in cells if c[1] == s and c[0] != br)
        z, p = st.two_proportion_z(x, n, x2, n2)
        tests.append((z, p, x2 / n2 if n2 else 0.0))
    qs = st.benjamini_hochberg([t[1] for t in tests])
    for i, (br, s, x, n) in enumerate(cells):
        if not _bh_flag(qs[i]) or n < SETTINGS["min_closed"]:
            continue
        z, p, rest = tests[i]
        b = m.branch_by_id[br]
        frm, to = STATUS_LABEL[FUNNEL_STAGES[s - 1]].lower(), STATUS_LABEL[FUNNEL_STAGES[s]].lower()
        low = z < 0
        f.add(Finding(
            id=f"funnel:{br}:{FUNNEL_STAGES[s]}", category="sales", direction="low" if low else "high",
            title=f"{b['name']}: {'unusually few' if low else 'unusually many'} customers get from {frm} to {to}",
            summary=f"{pct(x / n)} make this step at {b['name']}, against {pct(rest)} at the other branches.",
            observed=f"{pct(x / n)} ({x} of {n})", expected=f"{pct(rest)} at other branches", branchId=br,
            href=f"/dashboard/funnel?branch={br}",
            evidence=[Evidence("two-proportion", f"z = {_sign(z)}", f"q < {SETTINGS['fdr']} after Benjamini–Hochberg",
                               qs[i] < SETTINGS["high_p"], p, qs[i])],
        ))


def _fence_ev(value_text: str, fences_text: str, level: int) -> Evidence:
    return Evidence("tukey", f"{value_text} vs fences {fences_text}",
                    "beyond the outer fence (3 × IQR)" if level == 2 else "beyond the inner fence (1.5 × IQR)", level == 2)


# 3. First reply speed by rep
def _reply(m: Model, f: _Findings) -> None:
    reps = []
    for r in m.reps:
        hs = [l.first_contact_hours for l in m.leads if l.assigned_to == r["id"] and l.first_contact_hours is not None]
        if len(hs) >= 5:
            reps.append((r, len(hs), st.median(hs)))
    if len(reps) < SETTINGS["min_group"]:
        return
    vals = [h for (_, _, h) in reps]
    mz, fences, typical = st.modified_z(vals), st.tukey_fences(vals), st.median(vals)
    for i, (r, n, h) in enumerate(reps):
        level = st.fence_level(h, fences)
        if abs(mz[i]) <= SETTINGS["mod_z"] and level == 0:
            continue
        ev = []
        if abs(mz[i]) > SETTINGS["mod_z"]:
            ev.append(Evidence("modified-z", f"M = {_sign(mz[i])}", f"|M| > {SETTINGS['mod_z']}", abs(mz[i]) > 2 * SETTINGS["mod_z"]))
        if level:
            ev.append(_fence_ev(f"{h:.0f} h", f"{fences.inner_low:.0f}–{fences.inner_high:.0f} h", level))
        slow = h > typical
        f.add(Finding(
            id=f"reply:rep:{r['id']}", category="team", direction="high" if slow else "low",
            title=f"{r['name']} takes unusually long to reply to new enquiries" if slow else f"{r['name']} replies to new enquiries unusually fast",
            summary=f"Their typical first reply takes {h:.0f} hours. Most of the team replies in about {typical:.0f} hours.",
            observed=f"{h:.0f} h median ({n} enquiries)", expected=f"{typical:.0f} h team median",
            branchId=r["branch_id"], repId=r["id"], href=f"/dashboard/rep/{r['id']}", evidence=ev,
        ))


# 4. Delivery times
def _deliveries(m: Model, f: _Findings) -> None:
    ls = [l for l in m.leads if l.delivery]
    if len(ls) < SETTINGS["min_group"]:
        return
    days = [l.delivery["days_to_deliver"] for l in ls]
    fences, mz, typical = st.tukey_fences(days), st.modified_z(days), st.median(days)
    for i, l in enumerate(ls):
        level = st.fence_level(days[i], fences)
        z_hit = abs(mz[i]) > SETTINGS["mod_z"]
        if not level and not z_hit:
            continue
        ev = []
        if level:
            ev.append(_fence_ev(f"{days[i]} days", f"{fences.inner_low:.1f}–{fences.inner_high:.1f}", level))
        if z_hit:
            ev.append(Evidence("modified-z", f"M = {_sign(mz[i])}", f"|M| > {SETTINGS['mod_z']}", False))
        slow = days[i] > typical
        reason = l.delivery.get("delay_reason")
        f.add(Finding(
            id=f"delivery:{l.id}", category="delivery", direction="high" if slow else "low",
            title=f"{l.customer_name}'s {l.model_interested} took unusually long to deliver" if slow
            else f"{l.customer_name}'s {l.model_interested} was delivered unusually fast",
            summary=f"{days[i]} days from order to handover; most deliveries take {typical:g} days."
                    + (f" Reason given: {reason.lower()}." if reason else " No delay reason was recorded."),
            observed=f"{days[i]} days", expected=f"{typical:g} days typical (middle half {fences.q1:g}–{fences.q3:g})",
            branchId=l.branch_id, repId=l.assigned_to, leadIds=[l.id], href=f"/dashboard/rep/{l.assigned_to}", evidence=ev,
        ))


# 5. Price outliers within each car model
def _prices(m: Model, f: _Findings) -> None:
    by_model: dict[str, list[Lead]] = {}
    for l in m.leads:
        by_model.setdefault(l.model_interested, []).append(l)
    for model_name, ls in by_model.items():
        if len(ls) < SETTINGS["min_group"]:
            continue
        vals = [l.deal_value for l in ls]
        mz, fences, typical = st.modified_z(vals), st.tukey_fences(vals), st.median(vals)
        for i, l in enumerate(ls):
            level = st.fence_level(vals[i], fences)
            z_hit = abs(mz[i]) > SETTINGS["mod_z"]
            if not z_hit and level < 2:
                continue
            ev = []
            if z_hit:
                ev.append(Evidence("modified-z", f"M = {_sign(mz[i])}", f"|M| > {SETTINGS['mod_z']}", abs(mz[i]) > 2 * SETTINGS["mod_z"]))
            if level:
                ev.append(_fence_ev(inr(vals[i]), f"{inr(fences.inner_low)}–{inr(fences.inner_high)}", level))
            f.add(Finding(
                id=f"price:{l.id}", category="data", direction="high" if vals[i] > typical else "low",
                title=f"Unusual deal value for a {model_name}: {inr(vals[i])}",
                summary=f"{model_name} deals are usually around {inr(typical)}. This could be a typing mistake, a different variant, or a big discount.",
                observed=inr(vals[i]), expected=f"{inr(typical)} typical for a {model_name}",
                branchId=l.branch_id, repId=l.assigned_to, leadIds=[l.id], href=f"/dashboard/rep/{l.assigned_to}", evidence=ev,
            ))


# 6. Monthly volumes per branch
def _volumes(m: Model, f: _Findings) -> None:
    metrics = [("enquiries", lambda l: l.created_month, False), ("orders", lambda l: l.order_month, True)]
    cells = []
    for b in m.branches:
        for key, month_fn, skip_first in metrics:
            months = m.months[1:] if skip_first else m.months
            ys = [sum(1 for l in m.leads if l.branch_id == b["id"] and month_fn(l) == mo) for mo in months]
            if len(ys) < 4:
                continue
            mu0 = st.median(ys)
            sigma = max(st.sigma_from_moving_range(ys), math.sqrt(max(mu0, 1)))
            ew = st.ewma(ys, mu0, sigma, SETTINGS["ewma_lambda"], SETTINGS["ewma_L"])
            cu = st.cusum(ys, mu0, sigma, SETTINGS["cusum_k"], SETTINGS["cusum_h"])
            lo_lim, hi_lim = max(0.0, mu0 - SETTINGS["shewhart_L"] * sigma), mu0 + SETTINGS["shewhart_L"] * sigma

            def series(i: int) -> dict[str, Any]:
                return {"points": [{"label": month_label(mo, True), "value": ys[j], "flagged": j == i} for j, mo in enumerate(months)],
                        "centre": mu0, "lo": lo_lim, "hi": hi_lim}

            def base(i: int, d: str) -> Finding:
                return Finding(
                    id=f"volume:{b['id']}:{key}:{months[i]}", category="sales", direction=d,
                    title=f"{b['name']}: {'unusually few' if d == 'low' else 'unusually many'} {key} in {month_label(months[i])}",
                    summary=f"{ys[i]} {key} in {month_label(months[i])}, against a typical month of about {mu0:.0f}.",
                    observed=f"{ys[i]} {key}", expected=f"about {mu0:.0f} a month ({b['name']}'s median)",
                    branchId=b["id"], href=f"/dashboard/branch/{b['id']}", evidence=[], series=series(i),
                )
            for i, y in enumerate(ys):
                others = ys[:i] + ys[i + 1:]
                lam = sum(others) / len(others)
                p, d = st.poisson_test(y, lam)
                cells.append((b, key, months, ys, i, lam, p, d, series(i)))
                if abs(y - mu0) > SETTINGS["shewhart_L"] * sigma:
                    fd = base(i, "low" if y < mu0 else "high")
                    fd.evidence.append(Evidence("shewhart", f"{y} vs limits {lo_lim:.1f}–{hi_lim:.1f}",
                                                f"beyond median ± {SETTINGS['shewhart_L']}σ", True))
                    f.add(fd)
                if ew[i].out:
                    fd = base(i, "low" if ew[i].z < mu0 else "high")
                    fd.evidence.append(Evidence("ewma", f"EWMA = {ew[i].z:.1f} vs {ew[i].lcl:.1f}–{ew[i].ucl:.1f}",
                                                f"outside ±{SETTINGS['ewma_L']}σ EWMA limits (λ = {SETTINGS['ewma_lambda']})", False))
                    f.add(fd)
                if cu[i].signal and (i == 0 or cu[i - 1].signal != cu[i].signal):
                    sig = cu[i].signal
                    fd = base(i, sig)
                    fd.title = f"{b['name']}: {key} have {'been running low' if sig == 'low' else 'been running high'} since {month_label(months[max(0, i - 2)])}"
                    fd.summary = (f"Month after month, {key} have stayed {'below' if sig == 'low' else 'above'} {b['name']}'s typical "
                                  f"{mu0:.0f}. A sustained shift like this builds up even when no single month looks extreme.")
                    fd.evidence.append(Evidence("cusum", f"C{'⁺' if sig == 'high' else '⁻'} = {(cu[i].hi if sig == 'high' else cu[i].lo):.2f}",
                                                f"cumulative sum above h = {SETTINGS['cusum_h']} (k = {SETTINGS['cusum_k']})", False))
                    f.add(fd)
    if not cells:
        return
    qs = st.benjamini_hochberg([c[6] for c in cells])
    for k, (b, key, months, ys, i, lam, p, d, ser) in enumerate(cells):
        if not _bh_flag(qs[k]):
            continue
        fid = f"volume:{b['id']}:{key}:{months[i]}"
        ev = Evidence("poisson", f"{ys[i]} observed vs {lam:.1f} expected", f"q < {SETTINGS['fdr']} after Benjamini–Hochberg",
                      qs[k] < SETTINGS["high_p"], p, qs[k])
        f.corroborate(fid, ev)
        f.add(Finding(
            id=fid, category="sales", direction=d,
            title=f"{b['name']}: {'unusually few' if d == 'low' else 'unusually many'} {key} in {month_label(months[i])}",
            summary=f"{ys[i]} {key}, when the other months average {lam:.1f}.",
            observed=f"{ys[i]} {key}", expected=f"{lam:.1f} (average of the other months)",
            branchId=b["id"], href=f"/dashboard/branch/{b['id']}", evidence=[ev], series=ser,
        ))


# 7. Loss-reason mix by branch
def _loss_mix(m: Model, f: _Findings) -> None:
    lost = [l for l in m.leads if l.status == "lost" and l.lost_reason]
    reasons = sorted({l.lost_reason for l in lost})
    if len(reasons) < 2 or len(m.branches) < 2:
        return
    rows = [[sum(1 for l in lost if l.branch_id == b["id"] and l.lost_reason == r) for r in reasons] for b in m.branches]
    results = []
    for i, row in enumerate(rows):
        n = sum(row)
        other = [sum(r[j] for k, r in enumerate(rows) if k != i) for j in range(len(reasons))]
        on = sum(other)
        expected = [o / on * n if on else 0.0 for o in other]
        chi2, df, p, resid = st.chi2_gof(row, expected)
        results.append((n, expected, chi2, df, p, resid))
    qs = st.benjamini_hochberg([r[4] for r in results])
    for i, (n, expected, chi2, df, p, resid) in enumerate(results):
        if not _bh_flag(qs[i]) or n < 20:
            continue
        b = m.branches[i]
        top = resid.index(max(resid))
        f.add(Finding(
            id=f"loss-mix:{b['id']}", category="sales", direction="high",
            title=f"{b['name']} loses customers for different reasons than other branches",
            summary=f'"{reasons[top]}" comes up far more often here: {rows[i][top]} times, where about {expected[top]:.1f} would be normal for a branch this size.',
            observed=f'{rows[i][top]} × "{reasons[top]}"', expected=f"{expected[top]:.1f} based on the other branches",
            branchId=b["id"], href=f"/dashboard/funnel?branch={b['id']}",
            evidence=[Evidence("chi-square", f"χ² = {chi2:.2f}, df = {df}", f"q < {SETTINGS['fdr']} after Benjamini–Hochberg",
                               qs[i] < SETTINGS["high_p"], p, qs[i])],
        ))


# 8. Rep profile across several measures
def _profiles(m: Model, f: _Findings) -> None:
    names = ["conversion", "first reply (h)", "avg deal (₹L)", "reach test drive"]
    rows = []
    for r in m.reps:
        ls = [l for l in m.leads if l.assigned_to == r["id"]]
        closed = [l for l in ls if _closed(l)]
        hs = [l.first_contact_hours for l in ls if l.first_contact_hours is not None]
        if len(closed) < SETTINGS["min_closed"] or len(hs) < 5:
            continue
        rows.append((r["id"], [sum(1 for l in closed if _won(l)) / len(closed), st.median(hs),
                               sum(l.deal_value for l in ls) / len(ls) / 1e5, sum(1 for l in ls if l.max_stage >= 2) / len(ls)]))
    p = len(names)
    if len(rows) < 3 * p:
        return
    mu, cov = st.covariance([v for _, v in rows])
    inv = st.invert(cov)
    if inv is None:
        return
    sds = [st.sd([v[j] for _, v in rows]) for j in range(p)]
    d2 = [st.mahalanobis2(v, mu, inv) for _, v in rows]
    ps = [st.chi2_sf(d, p) for d in d2]
    qs = st.benjamini_hochberg(ps)

    def fmt(k: int, v: float) -> str:
        return pct(v) if k in (0, 3) else f"{v:.0f} h" if k == 1 else f"₹{v:.1f} L"
    for i, (rid, v) in enumerate(rows):
        if not _bh_flag(qs[i]):
            continue
        rep = m.rep_by_id[rid]
        zs = [(v[j] - mu[j]) / sds[j] if sds[j] else 0.0 for j in range(p)]
        j = max(range(p), key=lambda k: abs(zs[k]))
        f.add(Finding(
            id=f"profile:rep:{rid}", category="team", direction="low" if zs[j] < 0 else "high",
            title=f"{rep['name']}'s way of selling stands out from the team",
            summary=f"Taken together, their numbers don't look like anyone else's. The biggest difference is {names[j]}: "
                    f"{fmt(j, v[j])} against a team average of {fmt(j, mu[j])}.",
            observed=" · ".join(f"{n} {fmt(k, v[k])}" for k, n in enumerate(names)),
            expected=" · ".join(f"{n} {fmt(k, mu[k])}" for k, n in enumerate(names)),
            branchId=rep["branch_id"], repId=rid, href=f"/dashboard/rep/{rid}",
            evidence=[Evidence("mahalanobis", f"d² = {d2[i]:.2f} on {p} measures", f"χ²({p}) q < {SETTINGS['fdr']} after Benjamini–Hochberg",
                               qs[i] < SETTINGS["high_p"], ps[i], qs[i])],
        ))


# 9. Data consistency
def _consistency(m: Model, f: _Findings) -> None:
    from ..model import DAY, ts

    def skipped(l: Lead) -> bool:
        h = l.raw["status_history"]
        for i in range(1, len(h)):
            a, b = h[i - 1]["status"], h[i]["status"]
            if a in FUNNEL_STAGES and b in FUNNEL_STAGES and FUNNEL_STAGES.index(b) > FUNNEL_STAGES.index(a) + 1:
                return True
        return False

    checks = [
        ("status-history", "Some leads' status doesn't match their history",
         "The status field says one thing but the last step in the history says another. DealerPulse follows the history; the file is not changed.",
         [l for l in m.leads if l.status_in_file != l.status]),
        ("history-order", "Some leads have history steps out of time order",
         "A later step has an earlier timestamp than the step before it.",
         [l for l in m.leads if any(ts(h["timestamp"]) < ts(l.raw["status_history"][i - 1]["timestamp"])
                                    for i, h in enumerate(l.raw["status_history"]) if i)]),
        ("skipped-stage", "Some leads skipped a sales step",
         "The history jumps over a step, for example from new straight to order placed.", [l for l in m.leads if skipped(l)]),
        ("delivery-days", "Some delivery records don't add up",
         "The number of days to deliver doesn't match the gap between the order and delivery dates.",
         [l for l in m.leads if l.delivery and abs(round((ts(l.delivery["delivery_date"]) - ts(l.delivery["order_date"])) / DAY)
                                                    - l.delivery["days_to_deliver"]) > 1]),
        ("delivered-not-closed", "Some delivered cars are still shown as in progress",
         "There's a delivery record, but the lead's history never reaches delivered.",
         [l for l in m.leads if l.delivery and l.status != "delivered" and l.status in OPEN_STATUSES]),
    ]
    for key, title, summary, leads in checks:
        if not leads:
            continue
        sample = ", ".join(l.id for l in leads[:6]) + ("…" if len(leads) > 6 else "")
        f.add(Finding(
            id=f"data:{key}", category="data", direction="inconsistent", title=title,
            summary=f"{summary} Affects {len(leads)} lead{'s' if len(leads) > 1 else ''}: {sample}.",
            observed=f"{len(leads)} of {len(m.leads)} leads", expected="0", leadIds=[l.id for l in leads],
            branchId=leads[0].branch_id if len({l.branch_id for l in leads}) == 1 else None,
            evidence=[Evidence("consistency", f"{len(leads)} records", "fails a rule that should always hold", True)],
        ))
