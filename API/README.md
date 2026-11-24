# DealerPulse API

A Flask API for DealerPulse. It handles sign-in, user administration, data upload, paginated reads that are always filtered to what each person may see, anomaly detection with a review workflow, and notifications delivered as a stream.

A bundled SQLite database (`data/dealerpulse.db`) contains the sample data and a leadership login:

| Username | Password | Role |
|---|---|---|
| `Admin` | `Admin$123` | Leadership (CEO) |

> This is a proof of concept. Change the admin password (`POST /api/auth/password`) before anyone else uses it. The API logs a warning when it creates this default login.

## Run

### Locally

Requires Python 3.11 or later.

```bash
cd API
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
copy .env.example .env          # then set JWT_SECRET (see the file)
flask --app wsgi run --port 8000        # development server
pytest -q                               # 31 tests
```

### Docker

The image runs as a non-root user, under gunicorn with threaded workers so open notification streams don't block other requests.

```bash
cd API
docker compose up --build       # http://localhost:8000/api/health
```

`docker-compose.yml` keeps `data/` in a named volume, so uploads, logins and reviews survive restarts. In production mode the API refuses to start without `JWT_SECRET` in `.env`.

### Vercel

`vercel.json` routes every request to `api/index.py`, which exports the WSGI app. Set the project's Root Directory to `API`.

Serverless storage doesn't keep files, so on Vercel the SQLite file is used for local work only. Set `DATABASE_URL` to a hosted PostgreSQL database, e.g. `postgresql+psycopg://user:pass@host/db?sslmode=require`. On first start the API creates the tables, the admin login and the sample data.

Also set these variables:

- `JWT_SECRET`
- `CORS_ORIGINS`: the frontend's URL
- `HTTPS_ONLY=true`
- `STREAM_MAX_SECONDS=50`: Vercel ends functions after `maxDuration`, and the browser's EventSource reconnects automatically.
- `RATE_LIMIT_STORAGE`: a Redis URL, because in-memory limits are per instance.

### Resetting the database

```bash
python scripts/reset_db.py               # fresh: admin login + sample data
python scripts/reset_db.py --keep-users  # replace sales data only, keep logins, reviews and audit
```

`data/dealerpulse.db` is committed on purpose, so a zip of the repo carries a working database. Database files can't be merged, so after a conflict run `reset_db.py` rather than merging.

## Architecture

The code follows clean architecture: each layer depends only on the layers inside it, and the domain has no dependency on Flask or SQLAlchemy.

```
dealerpulse/
  domain/                  pure rules: no Flask, no SQL
    validation.py          dataset validation (same plain-language messages as the frontend)
    model.py               enriched leads ("today" = latest date in the file; status follows history)
    access.py              role-based access: row scope, field rules (mask/hide), review permissions
    anomaly/stats.py       statistics (NIST-tested)
    anomaly/detect.py      the detectors, a port of the frontend's (same ids, verified by tests)
  application/             use cases, written against interfaces only
    ports.py               repository, hasher, token and cache interfaces; Page/PageRequest
    services.py            Auth, User, Dataset, Query, Anomaly and Notification services
    errors.py              typed errors mapped to HTTP statuses
  infrastructure/          adapters
    db.py                  SQLAlchemy tables, indexes, SQLite pragmas (WAL, foreign keys)
    repositories.py        SQL implementations and the unit of work (one transaction per use case)
    security.py            scrypt hashing, JWT issue and verify
    cache.py               per-revision in-memory snapshot and per-scope derived data
  interfaces/http/         Flask
    app.py                 composition root, first-run bootstrap
    routes.py              thin endpoints
    schemas.py             pydantic request validation (unknown fields rejected)
    auth.py, limits.py, middleware.py   auth decorators, rate limits, headers, gzip, errors
```

### Why it's fast

- **Per-revision cache.** The current dataset is read from the database once per revision and kept in memory. Each role's scoped view, anomaly findings and JSON payload are computed once per revision and reused.
- **Indexed SQL for paginated lists.** List endpoints query the database with indexes on branch, rep, status and dates, and use `LIMIT`/`OFFSET`. Responses are compressed with gzip.
- **Conditional requests.** `GET /api/dataset` returns an ETag, and an unchanged dataset is answered with `304 Not Modified`.
- **SQLite in WAL mode.** Requests and streams can read while a write is in progress.

Measured on the Docker image with the sample data, warm:

| Request | Time |
|---|---|
| Scoped dataset, leadership (54 KB gzipped) | 13–30 ms |
| Scoped dataset, manager | 10–16 ms |
| Paginated leads | 30–40 ms |
| Anomaly list | 8–40 ms |
| Dataset with ETag (304) | 6–10 ms |
| First notification on a stream | 44 ms after connecting |

## Endpoints

Every endpoint except `/api/health` and `/api/auth/login` needs `Authorization: Bearer <access_token>`.

- **Paginated lists** accept `page` (from 1) and `page_size` (1–200, default 25). They return `{items, page, page_size, total, pages, has_next}`.
- **Errors** return `{error: {code, message, details?}}`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | anyone | Liveness |
| POST | `/api/auth/login` | anyone | `{username, password}` → `{access_token, expires_in, user}`. Rate-limited; 5 failures lock the login for 15 minutes. |
| POST | `/api/auth/refresh` | signed in | New access token |
| POST | `/api/auth/logout` | signed in | Revokes every token issued to this user |
| GET | `/api/auth/me` | signed in | Current user, role, rep and branch |
| POST | `/api/auth/password` | signed in | `{current_password, new_password}` |
| GET | `/api/users` | leadership | Logins (search `q`, `role`), paginated |
| GET | `/api/users/candidates` | leadership | People in the data without a login (`branch_id`, `q`), paginated |
| POST | `/api/users` | leadership | Create a login for an existing person: `{username, password, rep_id}`. Or add a new person: `{username, password, new_person: {name, branch_id, role}}`. Or create a leadership login: `{username, password, role: "ceo", display_name}`. |
| PATCH | `/api/users/{id}` | leadership | `{active?, password?, unlock?, display_name?}` |
| DELETE | `/api/users/{id}` | leadership | Remove a login |
| GET | `/api/dataset/info` | signed in | Current version (leadership also gets uploader and counts) |
| GET | `/api/dataset` | signed in | The whole dataset, **scoped to the caller**, in the same shape as an uploaded file. ETag/304. |
| POST | `/api/dataset` | leadership | Upload a JSON file. It's validated (422 with plain-language issues), then replaces the data. Optional `X-File-Name` header. |
| GET | `/api/leads` | signed in | Scoped, paginated. Filters: `status`, `branch_id`, `rep_id`, `source`, `q`, `created_from`/`created_to` (YYYY-MM or YYYY-MM-DD). `sort`: `[-]created_at`, `[-]last_activity_at`, `[-]deal_value`. |
| GET | `/api/leads/{id}` | signed in | One lead with history. 404 if outside your scope. |
| GET | `/api/branches`, `/api/sales-reps`, `/api/targets`, `/api/deliveries` | signed in | Scoped, paginated (`q` searches names) |
| GET | `/api/anomalies` | signed in | Scoped findings with review status (`status`, `category`, `branch_id`), plus `counts` per status |
| GET | `/api/anomalies/{id}` | signed in | One finding with its review history |
| PUT | `/api/anomalies/{id}/review` | leadership, manager (own branch) | `{decision: "confirmed"\|"dismissed", note}` |
| DELETE | `/api/anomalies/{id}/review` | leadership, manager (own branch) | Reopen for review |
| GET | `/api/notifications` | signed in | The caller's notices, paginated (`unread_only`), with `unread` count |
| POST | `/api/notifications/read` | signed in | `{ids: [...]}`. Only your own notices can be marked. |
| POST | `/api/notifications/stream-ticket` | signed in | 60-second ticket for the stream |
| GET | `/api/notifications/stream?ticket=` | ticket | Server-sent events (see below) |
| GET | `/api/audit` | leadership | Security and admin audit log, paginated (`action`) |

### Notification stream (server-sent events)

```js
const { ticket } = await post("/api/notifications/stream-ticket");
const es = new EventSource(`${API}/api/notifications/stream?ticket=${ticket}`);
es.addEventListener("notice", (e) => show(JSON.parse(e.data)));   // one event per unread notice
es.addEventListener("sync", (e) => setBadge(JSON.parse(e.data).unread));
es.addEventListener("bye", () => { /* the stream ends after STREAM_MAX_SECONDS; get a new ticket and reconnect */ });
```

- **On connect:** every unread notice arrives as its own `notice` event, followed by a `sync` event with the unread count.
- **After that:** the server checks for new data or review changes every `STREAM_POLL_SECONDS` and pushes only new notices. A `: ping` comment every 15 seconds keeps proxies from closing the connection.
- **Why a ticket:** an `EventSource` can't send headers, so it authenticates with a short-lived, stream-only ticket. Putting the access token in the URL would leave it in server and proxy logs.

## Roles and access

The rules match the frontend's (`../ACCESS_CONTROL.md`), but here the server enforces them:

- **Records:** leadership sees everything, a manager their own branch, a rep their own leads.
- **Fields:** leadership gets customer phone numbers masked, and reps don't get branch targets.
- **Filters:** query filters can only narrow the caller's scope, never widen it. For example, a B1 manager asking for `branch_id=B3` gets 0 results.
- **Single records:** a record outside your scope returns 404, so the API doesn't confirm it exists.

Logins are linked to people in the data:

- **Linking:** a manager or rep login points to a sales person (`rep_id`). Their branch is read from the current data at every request.
- **New people:** a person added through `new_person` gets an id like `ADM-001` and is kept across uploads while their branch still exists.
- **People removed by an upload:** their logins stop working, and the upload response lists them under `unlinked_logins`.

Security controls are mapped to the OWASP Top 10 in [SECURITY.md](./SECURITY.md).
