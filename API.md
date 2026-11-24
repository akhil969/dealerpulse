# DealerPulse API

The Flask API is in [`API/`](./API).

| Document | What's in it |
|---|---|
| [API/README.md](./API/README.md) | How to run it (local, Docker, Vercel), architecture, every endpoint, the notification stream |
| [API/SECURITY.md](./API/SECURITY.md) | OWASP Top 10 mapping |

## Summary

- **Sign-in:** `Admin` / `Admin$123` is the leadership login. Leadership creates logins for managers and reps, either for people already in the data or by adding a new person to a branch.
- **Data:** leadership uploads a JSON file (`POST /api/dataset`). It's validated with the same plain-language messages as the frontend, then replaces the stored data. Logins, reviews and the audit log survive uploads.
- **Reads** are always filtered to the caller on the server: rows, fields, single records and filters, following `ACCESS_CONTROL.md`. Every list endpoint is paginated (`page`, `page_size` ≤ 200).
- **Anomaly detection** runs on the server. It is a Python port of the browser version, and tests confirm it produces the same findings. Reviews are stored per dataset version, with an audit trail.
- **Notifications** are available paginated (`GET /api/notifications`) or as a live stream of server-sent events (`GET /api/notifications/stream`, authenticated with a 60-second ticket).
- **Storage:** SQLite in `API/data/dealerpulse.db`, committed so the repo zip is self-contained, for local and Docker use. On Vercel, `DATABASE_URL` points at PostgreSQL instead.

## Using it from the web app

When `frontend/.env.local` sets `NEXT_PUBLIC_API_URL`, the web app runs in **API mode**. All calls go through `frontend/src/lib/api.ts`.

| Web app | API |
|---|---|
| Sign-in form on the start screen; profile menu has Change password and Sign out | `/api/auth/login`, `/password`, `/logout`; the token is renewed every 20 minutes through `/refresh` |
| Dashboard data, already scoped to the person | `GET /api/dataset` and `/api/dataset/info` (shared "today" and month list) |
| **Data and logins** page (leadership only): upload a file, create and manage logins | `POST /api/dataset`, `/api/users`, `/api/users/candidates`, `/api/branches` |
| Unusual patterns: findings, review status, confirm, dismiss, undo | `GET /api/anomalies`, `PUT` and `DELETE /api/anomalies/{id}/review` |
| Notification bell and pop-ups | `GET /api/notifications`, `POST /read`, and the live stream (`/stream-ticket` then `/stream`), reconnecting automatically |

Without `NEXT_PUBLIC_API_URL`, the web app runs browser-only with sample or uploaded files and role selection, as before.

The token is kept in `sessionStorage`, so it's gone when the tab closes. A 401 from the API signs the person out.
