# DealerPulse

A sales dashboard for dealer groups. The web app (Next.js and Recharts) lives in [`frontend/`](./frontend), and the Flask API in [`API/`](./API).

| Document | What's in it |
|---|---|
| [LOCAL_SETUP.md](./LOCAL_SETUP.md) | Step-by-step setup and run guide for the web app and the API, with troubleshooting |
| [DECISIONS.md](./DECISIONS.md) | What was built and why, tradeoffs, patterns in the data, next steps |
| [ANOMALY_DETECTION.md](./ANOMALY_DETECTION.md) | The maths behind Unusual patterns, thresholds, results, references |
| [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) | Row, field and page-level access rules for each role |
| [API.md](./API.md) | Overview of the Flask API and the frontend integration status |
| [API/README.md](./API/README.md) | Running the API (local, Docker, Vercel), architecture, endpoints |
| [API/SECURITY.md](./API/SECURITY.md) | OWASP Top 10 mapping for the API |

## Run locally

Requires Node.js 20 or later. `npm test` needs Node 22.18 or later, because it runs TypeScript directly.

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run typecheck
npm test           # anomaly-maths unit tests (NIST worked examples)
```

Don't run `npm run build` while `npm run dev` is running: both write to `.next/`, and the dev server will start returning 500 errors.

### Demo links

These load the bundled sample data and sign you in:

- `/?sample=1&as=ceo`: leadership view
- `/?sample=1&as=SR1`: branch manager view (SR1 manages Downtown Toyota)
- `/?sample=1&as=SR13`: sales rep view
- Add `&next=/dashboard/anomalies` (or any `/dashboard/...` path) to open a specific page

## What's in it

- **Start screen:** add a JSON file or use the sample, pick a role, open the dashboard. File problems are explained in plain language. A template and the exact format are available.
- **Role-based access control:** pages only receive a role-scoped copy of the data, with rules at the row, field and page level. Leadership sees all branches with customer phone numbers masked. A manager sees only their branch, and a rep only their own leads, with no targets or peer comparisons. See [ACCESS_CONTROL.md](./ACCESS_CONTROL.md).
- **Drill-down:** leadership goes from all branches to a branch, then a person, then individual customers. Managers start at their branch. A month filter applies to every page.
- **Sales funnel:** stage-by-stage conversion, a what-if calculator, loss reasons, lead source and car model.
- **Follow-ups:** today's call list and late deliveries, with CSV export.
- **Unusual patterns:** statistical anomaly detection with false-discovery control. Every finding is flagged for review, and only confirmed findings are marked across the app.
- **Notifications:** a bell with items for the signed-in person. After the tour, unread items pop up one at a time.
- **Profile menu:** switch role, light, dark or automatic appearance, replay the tour, sign out.
- **Guided tour:** runs on each person's first visit.
- **Responsive navigation:** full labels on web, icons with short labels on tablet, a bottom tab bar on phones.
- **Lead status follows the history:** if a lead's `status` disagrees with its `status_history`, the history wins. The file itself is never changed.

## Project layout

```
frontend/
  public/sample-data.json      bundled sample dataset
  public/brand/toyota.svg      stand-in logo (replace with official artwork)
  src/app/                     pages: start screen and /dashboard/*
  src/components/              charts, tables, tour, bell, pop-ups, profile, nav
  src/lib/
    access.ts                  role-based access: row scope, field rules, page access
    validate.ts                file schema and plain-language validation
    analytics.ts               metrics and rule-based insights
    notifications.ts           per-role notifications
    anomaly/stats.ts           statistics (pure functions)
    anomaly/stats.test.ts      unit tests
    anomaly/detect.ts          detectors and thresholds
    anomaly/store.tsx          review workflow (flag → confirm or dismiss)
    api.ts                     Flask API client (off unless NEXT_PUBLIC_API_URL is set)
    store.tsx, user.ts, theme.tsx   data, role and theme state
```

## Run the API

```bash
cd API
docker compose up --build          # http://localhost:8000, sign in as Admin / Admin$123
```

Or run it locally with Python 3.11 or later, as described in [API/README.md](./API/README.md). The bundled SQLite database `API/data/dealerpulse.db` already has the sample data. `python API/scripts/reset_db.py` rebuilds it.

## Deploy to Vercel

Import the repo on vercel.com and set **Root Directory** to `frontend`. No environment variables are needed. Add `NEXT_PUBLIC_API_URL` only once the Flask API exists.

## Known limits

- There is no sign-in. Anyone can pick any role, as the brief allows. Access rules are enforced in the frontend only, so this is a pilot, not a security boundary. They move to the Flask API next (see ACCESS_CONTROL.md §6).
- Browser-only mode (no `NEXT_PUBLIC_API_URL`) keeps data, reviews and read notifications in the browser. API mode stores them on the server (see LOCAL_SETUP.md §5).
- The Toyota logo is a simplified stand-in.
