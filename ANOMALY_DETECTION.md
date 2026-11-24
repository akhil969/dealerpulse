# Anomaly detection: methods and mathematics

DealerPulse looks for numbers that are too far from normal to be explained by chance. **Nothing is marked as a problem automatically.** Every finding is *flagged for review*, and it only counts as a problem once a person confirms it.

Code:

| File | Contents |
|---|---|
| `frontend/src/lib/anomaly/stats.ts` | The maths: pure functions, no dependencies |
| `API/dealerpulse/domain/anomaly/` | Python port used by the API, tested to give the same findings (`API/tests/test_api.py::test_findings_match_typescript`) |
| `frontend/src/lib/anomaly/stats.test.ts` | Unit tests against published worked examples (`npm test`) |
| `frontend/src/lib/anomaly/detect.ts` | Detectors that apply the maths to dealership data; all thresholds are in `SETTINGS` |
| `frontend/src/lib/anomaly/store.tsx` | Review workflow: flag → confirm or dismiss, with an audit trail |
| `frontend/src/app/dashboard/anomalies/page.tsx` | The "Unusual patterns" review screen |

---

## 1. Review workflow

```
detected ──► FLAGGED ("Waiting for review")
                 │
     reviewer: "Yes, confirm it" ──► CONFIRMED ──► marked across the app
     reviewer: "No, dismiss"     ──► DISMISSED ──► kept for the record, not marked
                 ▲
     "Undo and review again" ───────┘  (audit trail kept)
```

- **Who reviews.** Leadership can review everything. A branch manager can review only findings about their own branch. Sales reps can't review, and they only ever see findings about themselves once someone has confirmed them.
- **What "marked" means.** Only a *confirmed* finding:
  - appears in a **Confirmed problems** card on the overview, branch and rep pages;
  - adds a **⚑** badge next to the branch or person in the tables;
  - sends a **notification** to the affected manager or rep.

  A flagged finding only appears in the review queue, plus one "N unusual patterns waiting for your review" notification for reviewers.
- **Audit trail.** Each decision stores the decision, an optional note, the reviewer's name, their role and the time, plus the full history of earlier decisions and reopenings.
- **Data is never changed.** Reviews are stored next to the data, keyed by a fingerprint of the dataset: in `localStorage` for now, or through the Flask API when `NEXT_PUBLIC_API_URL` is set (see `API.md`). A different file has its own review history.
- **Stable ids.** Detection is deterministic. A finding's id is built from what it is about, e.g. `conversion:branch:B3` or `volume:B1:enquiries:2025-11`, so a review stays attached to its finding when the page reloads.

---

## 2. Methods

Notation: $x_i$ are observations, $n$ is their count, $\tilde{x}$ is the median and $\Phi$ is the standard normal CDF.

### 2.1 Modified z-score (robust outlier score)

A plain z-score $Z_i = (x_i-\bar{x})/s$ is unreliable in small samples. NIST notes that its maximum is bounded by $(n-1)/\sqrt{n}$, and a single outlier inflates both $\bar{x}$ and $s$. Iglewicz and Hoaglin's modified z-score uses the median and the median absolute deviation instead:

$$\text{MAD} = \operatorname{median}_i\,|x_i - \tilde{x}|, \qquad M_i = \frac{0.6745\,(x_i - \tilde{x})}{\text{MAD}}$$

The constant $0.6745 = \Phi^{-1}(0.75)$ makes $\text{MAD}/0.6745$ estimate $\sigma$ for normal data. **Flag when $|M_i| > 3.5$**, as the authors recommend.

If more than half the values are identical, MAD is 0. In that case the mean absolute deviation is used instead: $M_i = (x_i-\tilde{x}) / (1.253314 \cdot \text{MeanAD})$, where $1.253314 = \sqrt{\pi/2}$.

*Used for:* conversion rates across reps and branches (as corroboration), each rep's median first-reply time, delivery days, and deal value within each car model.

### 2.2 Tukey box-plot fences

Using the NIST quantile rule (the $p$-th quantile sits at position $p(n+1)$ in the sorted data, interpolated linearly):

$$\text{IQR} = Q_3 - Q_1$$
$$\text{inner fences} = Q_1 - 1.5\,\text{IQR},\; Q_3 + 1.5\,\text{IQR}$$
$$\text{outer fences} = Q_1 - 3\,\text{IQR},\; Q_3 + 3\,\text{IQR}$$

A value beyond an inner fence is a *mild* outlier; beyond an outer fence it is *extreme*, which counts as strong evidence. Fences make no assumption about the shape of the data, which suits skewed measures like delivery days.

*Used for:* delivery days, rep first-reply times, and deal values. Deal values are flagged only at the outer fence, because normal variant pricing often crosses the inner fence.

### 2.3 Two-proportion z-test with Wilson interval

This compares one group's rate $p_1 = x_1/n_1$ with everyone else's rate $p_2 = x_2/n_2$ (pooled variance under $H_0: p_1 = p_2$):

$$\hat{p} = \frac{x_1+x_2}{n_1+n_2}, \qquad z = \frac{p_1 - p_2}{\sqrt{\hat{p}(1-\hat{p})\left(\frac1{n_1}+\frac1{n_2}\right)}}, \qquad p = 2\,(1-\Phi(|z|))$$

The likely range shown on each card is the 95% **Wilson score interval**, which behaves well for small $n$ and for rates near 0% or 100%:

$$\frac{1}{1+\frac{z^2}{n}}\left(\hat{p} + \frac{z^2}{2n} \pm z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}\right), \qquad z = 1.96$$

Only *finished* enquiries count: an enquiry is finished once it has been ordered or lost. Including leads still in progress would penalise anyone with a lot of recent enquiries. Groups with fewer than 8 finished enquiries are not tested.

When there is no comparison group (for example, a manager's single-branch view), the test returns p = 1, meaning no evidence. Earlier versions divided 0 by 0 there, and the resulting NaN passed the threshold check.

*Used for:* conversion of each rep and each branch against the rest of the network, and each funnel step (new → contacted, …, ordered → delivered) at each branch against the other branches. A funnel step's denominator leaves out leads still sitting at that step.

### 2.4 Exact Poisson count test

Monthly counts (enquiries, orders) are modelled as Poisson. For an observed count $k$ and an expected rate $\lambda$:

$$P(X \le k) = Q(k+1, \lambda), \qquad P(X \ge k) = P(k, \lambda), \qquad p = \min\big(1,\; 2\min[P(X\le k),\,P(X\ge k)]\big)$$

$P$ and $Q$ are the regularised incomplete gamma functions. $\lambda$ is the **average of the branch's other months** (leave-one-out), so the month being tested doesn't inflate its own baseline.

*Used for:* each branch-month of enquiries and orders.

### 2.5 Control charts (EWMA, CUSUM, Shewhart)

These treat each branch's monthly series like a process on a gauge.

**Baseline.** The centre $\mu_0$ is the median month, which is robust to one odd month. Process σ is estimated the way a Shewhart individuals chart does it, from the average moving range, with a Poisson floor so short series don't produce unrealistically tight limits:

$$\hat\sigma = \max\left(\frac{\overline{MR}}{d_2},\ \sqrt{\mu_0}\right), \qquad \overline{MR} = \frac{1}{n-1}\sum_{t=2}^{n}|y_t - y_{t-1}|, \qquad d_2 = 1.128$$

**Shewhart 3-sigma.** Flag a month when $|y_t - \mu_0| > 3\hat\sigma$. This is good at large, sudden jumps.

**EWMA (Roberts, 1959).** This catches smaller or gradual drifts:

$$z_t = \lambda y_t + (1-\lambda) z_{t-1}, \qquad z_0 = \mu_0, \qquad \lambda = 0.3$$
$$\text{limits} = \mu_0 \pm L\,\hat\sigma\sqrt{\frac{\lambda}{2-\lambda}\left[1-(1-\lambda)^{2t}\right]}, \qquad L = 3$$

These are the exact time-varying limits. As $t$ grows they tend to NIST's asymptotic form $\mu_0 \pm L\hat\sigma\sqrt{\lambda/(2-\lambda)}$. NIST suggests λ between 0.2 and 0.3.

**Tabular CUSUM.** This catches a *sustained* shift, where several modest months add up even though none looks extreme on its own. In σ units:

$$C^+_t = \max\left(0,\ C^+_{t-1} + \frac{y_t-\mu_0}{\hat\sigma} - k\right), \qquad C^-_t = \max\left(0,\ C^-_{t-1} - \frac{y_t-\mu_0}{\hat\sigma} - k\right)$$

It signals when $C^\pm_t > h$, with $k = 0.5$ and $h = 4$. From NIST's average-run-length table, an in-control process gives a false signal about once every 336 periods, and a 1σ shift is caught in about 8. Only the month where the signal first appears is flagged.

*Used for:* each branch's monthly enquiries and orders. For orders the first month is excluded, because orders lag enquiries by weeks and the data starts with an empty pipeline. Every chart signal and Poisson result for the same branch-month is merged into one finding.

### 2.6 Chi-square test of the loss-reason mix

For each branch, its counts of lost reasons $O_j$ are compared with what the **other branches'** proportions predict for a branch of its size:

$$E_j = n_{\text{branch}} \cdot \frac{O^{\text{others}}_j}{\sum_j O^{\text{others}}_j}, \qquad \chi^2 = \sum_j \frac{(O_j - E_j)^2}{E_j}, \qquad \text{df} = c - 1$$
$$p = Q\!\left(\tfrac{\text{df}}{2}, \tfrac{\chi^2}{2}\right)$$

The reason that drives the difference is the one with the largest Pearson residual $(O_j - E_j)/\sqrt{E_j}$. Branches with fewer than 20 recorded loss reasons are skipped.

### 2.7 Mahalanobis distance (several measures at once)

A rep can look normal on every single number but unusual in combination. Each rep with enough data is described by a vector of 4 measures: conversion, median first-reply hours, average deal value, and the share of enquiries reaching a test drive. Then:

$$d^2 = (\mathbf{x} - \boldsymbol\mu)^\top \boldsymbol\Sigma^{-1} (\mathbf{x} - \boldsymbol\mu)$$

$\boldsymbol\mu$ and $\boldsymbol\Sigma$ are the sample mean and the covariance with divisor $n-1$, and $\boldsymbol\Sigma^{-1}$ is computed by Gauss–Jordan elimination with partial pivoting. Under multivariate normality $d^2 \sim \chi^2_p$, so $p = Q(p/2, d^2/2)$. Loss rate is deliberately left out: it equals $1 -$ conversion, which would make $\boldsymbol\Sigma$ singular. The test runs only when there are at least $3p$ reps, and the card names the measure with the largest standardised gap.

### 2.8 Benjamini–Hochberg false-discovery control

Testing about 25 reps, 25 funnel cells and 65 branch-months at α = 0.05 each would produce several false alarms by chance alone. Every family of p-value tests is therefore adjusted. With the $m$ p-values sorted ascending:

$$q_{(i)} = \min_{j \ge i} \left(\frac{m\, p_{(j)}}{j}\right), \quad \text{capped at } 1$$

A finding is flagged only when **q < 0.05**, which keeps the expected share of false findings among those flagged at or below 5%. The families are rep conversion, branch conversion, funnel cells, branch-months (Poisson), loss mixes and rep profiles.

### 2.9 Consistency checks (deterministic)

These are rules that must always hold. Any violation is flagged with strong evidence:

- the lead's status matches the last step in its history;
- history timestamps are in order;
- no funnel step is skipped;
- `days_to_deliver` equals the delivery date minus the order date, ±1 day;
- a lead with a delivery record has a history that reaches delivered.

### 2.10 Numerical building blocks

| Function | Method | Accuracy |
|---|---|---|
| $\Phi(z)$ | erf, Abramowitz & Stegun 7.1.26 | absolute error < 1.5 × 10⁻⁷ |
| $\ln\Gamma(x)$ | Lanczos approximation, g = 7, 9 terms | ~15 significant digits |
| $P(a,x)$, $Q(a,x)$ | series for $x < a+1$, otherwise Lentz continued fraction (Numerical Recipes §6.2) | relative tolerance 10⁻¹⁵ |
| χ² upper tail, Poisson CDF | expressed through $P$ and $Q$ | inherits the above |

---

## 3. Combining evidence and confidence

Findings about the same thing are merged. For example, a Poisson hit and an EWMA signal on the same branch-month become one card listing both checks.

- **Strong evidence** means any of: two or more independent methods agree; q (or p) < 0.001; a value beyond Tukey's outer fence; $|M| > 7$; a Shewhart breach; or a failed consistency rule.
- **Some evidence** means everything else.
- The ranking score is $100\cdot[\text{strong}] + 10\cdot(\#\text{methods}) + \min\!\left(40,\ -\log_{10} q_{\min}\right)$.

| Setting | Value | Why |
|---|---|---|
| `fdr` | 0.05 | Conventional false-discovery rate |
| `modZ` | 3.5 | Iglewicz & Hoaglin recommendation |
| `minClosed`, `minGroup` | 8 | Below this, rates and robust scores are too noisy |
| `ewmaLambda`, `ewmaL` | 0.3, 3 | NIST guidance (λ 0.2–0.3, 3σ limits) |
| `cusumK`, `cusumH` | 0.5, 4 | ARL₀ ≈ 336 and ARL ≈ 8 for a 1σ shift (NIST table) |
| `shewhartL` | 3 | Classic 3σ, false-alarm rate 0.27% per point |
| `highP` | 0.001 | Threshold for "strong evidence" |

---

## 4. Results on the sample data

All 510 leads are checked in about 15 ms in the browser. These 8 findings are flagged:

| Finding | Method | Statistic |
|---|---|---|
| Lakeside Toyota converts 14% of finished enquiries (likely range 8–24%) against 47% elsewhere | two-proportion z | z = −5.24, q < 0.0001 |
| Lakeside: new → contacted 60% vs 81% | two-proportion z | z = −4.12, q = 0.0009 |
| Lakeside: test drive → negotiation 54% vs 84% | two-proportion z | z = −3.71, q = 0.0026 |
| Lakeside: contacted → test drive 63% vs 82% | two-proportion z | z = −3.00, q = 0.023 |
| Downtown Toyota: 27 enquiries in Nov 2025 vs 11.7 expected | Poisson | q = 0.011 |
| Downtown Toyota: 4 enquiries in Aug 2025 vs 15.5 expected | Poisson | q = 0.038 |
| Eastside Toyota's loss reasons differ: "Dissatisfied with test drive" 11 vs 5.2 expected | χ², df = 7 | χ² = 21.59, q = 0.015 |
| 14 leads have a status that disagrees with their history | consistency | 14 records |

No rep-level, delivery, price or multi-measure finding passes the thresholds. The three Lakeside funnel findings agree with each other, which points to a problem early in the funnel (first contact and test drives) rather than at closing.

---

## 5. Methods considered and not used

| Method | Why not |
|---|---|
| Plain z-score | Bounded by $(n-1)/\sqrt{n}$ and distorted by the outliers it is looking for (NIST) |
| Grubbs / generalized ESD | Assume normality and suit one variable; delivery days and prices are skewed or vary by model. MAD and fences cover the same need without that assumption. |
| Seasonal decomposition (STL, Holt–Winters) | Needs at least two full seasonal cycles; the data covers 7 months |
| Benford's law | Deal values span less than one order of magnitude within a model, so the leading-digit law doesn't apply |
| Isolation forest, autoencoders | Need far more data, can't be explained to a manager, and add dependencies |

---

## 6. Limitations

- Seven monthly points are a short series for control charts. The Poisson floor on σ and the review step keep this conservative.
- Leads are assumed independent. A single campaign that brings in many related leads breaks that assumption.
- Benjamini–Hochberg control is exact for independent or positively dependent tests. Some families here are mildly dependent; Benjamini–Yekutieli would be the stricter alternative.
- Mahalanobis uses the classical covariance, which an extreme rep can mask. A robust estimator such as Minimum Covariance Determinant would be the next step.
- Statistical significance is not business importance. That is why every finding goes to a person for review.

---

## 7. References

- NIST/SEMATECH e-Handbook of Statistical Methods:
  - §1.3.5.17, Detection of Outliers (modified z-score): https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm
  - §7.1.6, What are outliers in the data? (box-plot fences): https://www.itl.nist.gov/div898/handbook/prc/section1/prc16.htm
  - §6.3.2.4, EWMA Control Charts: https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc324.htm
  - §6.3.2.3.1, CUSUM Average Run Length: https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc3231.htm
  - §7.4.5, Contingency tables and χ²: https://www.itl.nist.gov/div898/handbook/prc/section4/prc45.htm
- Iglewicz, B. & Hoaglin, D. (1993). *How to Detect and Handle Outliers*. ASQC.
- Tukey, J. W. (1977). *Exploratory Data Analysis*. Addison-Wesley.
- Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference. *JASA* 22, 209–212.
- Roberts, S. W. (1959). Control chart tests based on geometric moving averages. *Technometrics* 1, 239–250.
- Page, E. S. (1954). Continuous inspection schemes. *Biometrika* 41, 100–115.
- Montgomery, D. C. *Introduction to Statistical Quality Control* (EWMA exact limits, tabular CUSUM).
- Mahalanobis, P. C. (1936). On the generalised distance in statistics.
- Benjamini, Y. & Hochberg, Y. (1995). Controlling the false discovery rate. *JRSS B* 57, 289–300.
- Abramowitz, M. & Stegun, I. (1964). *Handbook of Mathematical Functions*, 7.1.26.
- Press, W. H. et al. *Numerical Recipes*, §6.1–6.2 (gamma function, incomplete gamma).

Each test in `stats.test.ts` reproduces a published worked example:

| Test | Expected result |
|---|---|
| NIST box-plot example (N = 90) | Q₁ = 429.75, Q₃ = 742.25, one mild outlier (1441) |
| NIST EWMA example | the published EWMA series, and UCL → 52.5884 |
| NIST wafer contingency table | χ² = 19.18, df = 6, p = 0.00387 |
| Wilson interval for 8 successes in 10 | (0.4902, 0.9433) |
| Benjamini–Hochberg | hand-computed q-values |
