# DECISIONS

## What I built and why

DealerPulse is a sales dashboard for a dealer group's leadership, branch managers and sales reps. Every screen answers four questions, in this order:

1. **Are we hitting target?** A gauge and a one-line verdict at the top of every page, then cars ordered and order value against target.
2. **What needs attention right now?** A ranked list in plain language. Each item says what is wrong and what to do, and links to the customers behind it.
3. **Who and where?** You can drill down from all branches to one branch, then to one person, then to individual customers with their last note.
4. **Is anything unusual?** Statistical checks flag numbers that are too far from normal to be chance. A person then confirms or dismisses each one.

### Pages

| Page | Purpose |
|---|---|
| `/` Start | Three steps: add your data, tell us who you are (Leadership, Branch manager or Sales rep), open your dashboard. Includes sample data, a downloadable template and a plain-language guide to the file format. |
| `/dashboard` Overview | Network gauge and verdict, key numbers, "What needs attention", orders against target, each branch's progress, branch table, monthly activity |
| `/dashboard/branch/[id]` | The same for one branch, plus its team, its funnel and customers going quiet |
| `/dashboard/rep/[id]` | One person's conversion against their branch average, rank in the branch, their customers, funnel and loss reasons |
| `/dashboard/funnel` | Stage-by-stage conversion, a what-if calculator, why customers didn't buy, conversion by lead source and by car model |
| `/dashboard/followups` | Today's call list: customers with no contact for 7, 14 or 30+ days, and cars ordered over 30 days ago that still aren't delivered. Filter by branch or person, export to CSV. |
| `/dashboard/anomalies` | Unusual patterns, sorted into To review, Confirmed and Dismissed |

Across the app:

- **Month filter:** All months, Last 3, Latest, or a custom from/to range. It applies to every page.
- **Shareable links:** the branch, person and view are kept in the URL, e.g. `?branch=B3&view=orders`.
- **Account features:** a profile menu, a notification bell, pop-up notifications, a first-time guided tour, and light, dark or automatic appearance.

## Key product decisions and tradeoffs

### Data and processing
- **The JSON file is processed in the browser.** The brief allows this. 510 leads parse, validate and aggregate in a few milliseconds, and anomaly detection takes about 15 ms. With no backend there's nothing to secure and no customer data leaves the browser, so Vercel can serve the app as a static site. The tradeoff is that nothing is shared between people or devices yet. Every backend call already goes through `frontend/src/lib/api.ts`, ready for the planned Flask API (`API.md`).
- **Validation is strict, and the messages are plain.** Checks cover:
  - the file's structure, field types and allowed values;
  - date formats;
  - unique IDs;
  - every `branch_id`, `assigned_to` and `lead_id` pointing to a real record;
  - one target per branch per month.

  Errors read like "Lead 4 (L0044), Status is "won", which isn't allowed", with the technical location shown beside them. Problems that don't block analysis appear as warnings. The format shown on screen is generated from the same schema the validator uses, so the two can't drift apart.
- **A lead's status follows its history.** 14 leads are marked `lost` in the file, but their history never records a loss. DealerPulse goes by the last step in the history and treats them as still in progress. The file is never changed, and the mismatch is flagged as a data-quality item for review.

### Metrics
- **"Sales" means cars ordered,** dated by the `order_placed` step. That is how dealerships usually track unit targets. Deliveries are tracked separately because they lag orders by about 18 days.
- **Conversion is counted per group of enquiries:** the share of enquiries *created* in the period that went on to an order. This avoids rates above 100% for short periods. The downside is that the latest month looks weaker, because its enquiries haven't finished yet.
- **"Today" is the latest date in the data** (31 Dec 2025), not the real clock. Otherwise every customer in a historical file would look months overdue.
- **Follow-ups ignore the month filter.** "Who should I call today" depends on where things stand now, not on a historical range.

### Roles and attention
- **Each role sees only its own data, even in this frontend-only pilot.** The full file stays private in the store. Pages only get a copy filtered by `frontend/src/lib/access.ts`, which plays the part of the future API. The rules work at three levels:
  - **Rows:** leadership sees all branches, a manager their own branch, a rep their own leads.
  - **Fields:** leadership sees customer phone numbers masked, and reps don't get branch targets.
  - **Pages:** out-of-scope pages redirect to the person's own home page.

  Managers and reps get no "All branches" view, picker or breadcrumb. Reps see no peer ranking or branch average. Totals, notifications and anomaly checks are all computed from the scoped copy, so nothing is inferred from rows a role can't see. When the Flask API exists, the same policy table moves to the server. See `ACCESS_CONTROL.md`.
- **Roles are chosen on the start screen, not logged in.** The brief says to skip authentication. The role decides where you land and what you're alerted about:
  - Leadership: the network.
  - Managers: their branch.
  - Reps: their own customers.
- **Notifications only include things the person can act on:**
  - Leadership: branches far behind target, plus items waiting for review.
  - Managers: their branch's issues, reps with several quiet customers, and items to review.
  - Reps: their own quiet customers, late deliveries and new enquiries.

  After the tour, unread items pop up one after another, up to 4 per visit, once per browser session. Each person's read state is saved.
- **Insights are rule-based, not written by an AI model.** They are deterministic, explainable and free. The rules are in `frontend/src/lib/analytics.ts`, in `insights()`.

### Anomaly detection
- **Nothing is marked automatically.** Every statistical finding is flagged for review. Only after a reviewer chooses "Yes, confirm it" does it show up as a confirmed problem: a card on the overview, branch and rep pages, a ⚑ badge in the tables, and a notification to the person affected.
- **Who can review:** leadership can review everything, and a branch manager only their own branch. Reps can't review, and they only ever see confirmed findings about themselves.
- **Audit trail:** each decision records the reviewer, the time and an optional note. Decisions can be undone.
- **Maths chosen for small, noisy data:**
  - robust scores (median and MAD) and Tukey fences, instead of plain z-scores;
  - Wilson ranges for rates;
  - exact Poisson tests for counts;
  - EWMA, CUSUM and Shewhart charts for monthly series;
  - χ² for the mix of loss reasons;
  - Mahalanobis distance for unusual combinations of measures;
  - Benjamini–Hochberg correction, so testing many things at once doesn't produce false alarms.

  All formulas, thresholds and sources are in `ANOMALY_DETECTION.md`. The maths is unit-tested against NIST's published worked examples.

### Design
- **The visual idea is a car's instrument cluster.** Each page opens with a dark band holding a gauge with red, amber and green zones, and a one-sentence verdict. Below it everything stays quiet: neutral greys, one red for problems, amber and green for status. Fonts are Bricolage Grotesque for headings, Instrument Sans for text and IBM Plex Mono for small labels.
- **Responsive layout, tested at 390, 820, 1280 and 1920 pixels wide.**
  - Web: the full navigation.
  - Tablet: icons with short labels.
  - Phone: a bottom tab bar.

  Layouts are compact so the key numbers appear without scrolling. Nothing spills sideways off the screen.
- **Accessibility basics:**
  - keyboard focus is visible, and Escape closes menus and the tour;
  - every number has a "?" tooltip in plain words;
  - reduced-motion settings are respected;
  - colour is never the only signal.
- **Toyota logo:** it appears only when every branch in the file is a Toyota branch. It is a simplified stand-in; use the official artwork before a public launch.
- **Few dependencies:** Next.js, React and Recharts. Styling is plain CSS with light and dark theme variables. The maths is written in-house, with no stats library.

### Backend (Flask API)
- **Clean architecture.** The domain layer (validation, the access policy, anomaly maths) has no Flask or SQL in it. Use cases depend on interfaces (ports), and SQLAlchemy, JWT and the cache are adapters behind those interfaces. This lets the same rules run in tests without a server, and lets the database change from SQLite to PostgreSQL without touching business code.
- **SQLite for the proof of concept, PostgreSQL for hosting.** The committed `.db` file makes the repo zip self-contained. Vercel functions can't keep a file, so there `DATABASE_URL` points at a hosted database. The code is the same for both.
- **Speed comes from a per-revision cache.** The whole dataset is about 600 KB, so it's read from the database once per upload and kept in memory, with each role's view and anomaly findings computed once and reused. Paginated list endpoints still query the database with indexes, so they scale past the cache.
- **Server-sent events rather than WebSockets** for notifications. Notifications only travel one way, SSE works through plain HTTP and proxies, and the browser reconnects on its own, which suits Vercel's time-limited functions. Because EventSource can't send headers, it signs in with a 60-second stream-only ticket, which keeps access tokens out of URLs and logs.
- **The anomaly maths is ported, not shared.** The server computes findings in Python, and a test checks that it produces exactly the same finding ids, confidence levels and methods as the TypeScript version on the sample data and on scoped views. Writing the port exposed a TypeScript bug: with no comparison group, a 0/0 division produced NaN, which passed the threshold check and created false findings in single-branch views. Both versions now treat "nothing to compare with" as no evidence.
- **Security follows OWASP Top 10** (see `API/SECURITY.md`), including:
  - a server-side access policy with object-level 404s;
  - scrypt password hashing;
  - pinned-algorithm JWTs with revocation;
  - lockout and rate limits;
  - strict input validation;
  - security headers and a CORS allow-list;
  - an audit log;
  - a non-root container.

  The seeded `Admin$123` password is a deliberate shortcut for the proof of concept.

## Patterns in the data

- **The targets can't be reached with the current enquiry volume.** 198 cars were ordered against a target of 1,426 (14%). Only 510 enquiries came in, so the target would be missed even if every one of them bought a car. At today's 39% conversion, hitting target would need about 3,700 enquiries. This is a lead-generation or target-setting problem more than a selling problem.
- **Lakeside Toyota (Bangalore) is the outlier.** It converts 12.7% of enquiries, against 39–47% at the other branches, and reached 4% of its target. In Dec 2025 it ordered 1 car against a target of 42. Anomaly detection confirms the gap is far too large to be chance: 14% against 47% on finished enquiries, z = −5.2. It also locates where Lakeside loses customers, counting only enquiries that have moved past each step: new → contacted (60% against 81% elsewhere), contacted → test drive (63% against 82%) and test drive → negotiation (54% against 84%). So the problem is early in the funnel, not at closing.
- **24 cars worth ₹5.5 Cr were ordered over 30 days ago and still aren't delivered.** The oldest has waited 195 days. This is the most urgent operational issue.
- **Downtown Toyota's enquiries swing sharply.** It had 27 in November against about 12 expected, and 4 in August against about 16. Both pass the Poisson test after correction. Worth checking whether a campaign or a data gap caused them.
- **Eastside Toyota loses more customers to "Dissatisfied with test drive"** than other branches: 11 times, where about 5 would be normal (χ² test, q = 0.015).
- **Walk-ins convert best (59%) and social media worst (17%).** Social media brings in as many enquiries as phone calls but converts at about half the rate.
- **Rep conversion ranges from 8% to 71%** among reps with 5 or more enquiries. After correcting for testing many reps at once, no single rep is statistically unusual, so coaching should focus on the branch-level gap rather than on individuals.
- **45% of deliveries were delayed.** The most common cause is the customer asking for a date change (18), followed by logistics in transit (11).
- **First replies take about 46 hours on average,** which is slow for walk-ins and phone enquiries.
- **Data quality:** apart from the 14 status mismatches, the file is clean. Delivery day counts match the dates, history steps are in order, and no stage is skipped.

## What I'd build next

- **Connect the frontend to the Flask API:** sign in, load scoped data, upload through the API, save reviews and read status on the server, and receive notifications from the stream. The browser-only mode would stay as an offline demo.
- **Forecasting and pacing:** project month-end orders from the open pipeline and historical stage conversion, e.g. "10 days left, need 12 more orders".
- **Anomaly detection on weekly data** once a longer history exists, plus seasonal baselines after 2 or more years of data.
- **Email or WhatsApp digests** of each person's notifications and follow-up list.
- **More tests:** unit tests for `validate.ts` and `analytics.ts` (the anomaly maths already has them) and a Playwright smoke test of the main pages in CI.
- **Optional AI-written summaries,** built only from the computed insights (never from raw customer data), with the rule-based text as the fallback.
