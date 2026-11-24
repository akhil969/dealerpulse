# Local setup guide

This guide starts DealerPulse on your own machine: the **web app** on http://localhost:3000 and the **API** on http://localhost:8000. They run independently, so start one or both.

> **Two ways to run the web app.** With `frontend/.env.local` containing `NEXT_PUBLIC_API_URL=http://localhost:8000`, it runs in **API mode**: you sign in, and data, uploads, logins, reviews and notifications all go through the API. Without that file it runs **browser-only** with sample data and role selection. The quickest full setup is step 3 (API), then step 2 (web app), then step 5.

## 1. Prerequisites

| Tool | Version | Check | Needed for |
|---|---|---|---|
| Node.js | 20 or later (22.18+ for `npm test`) | `node -v` | Web app |
| npm | comes with Node | `npm -v` | Web app |
| Python | 3.11 or later | `python --version` | API (without Docker) |
| Docker Desktop | any recent version | `docker --version` | API (with Docker, optional) |

No database server is needed. The API uses the SQLite file `API/data/dealerpulse.db`, which is committed with the sample data and an `Admin` login.

## 2. Web app (http://localhost:3000)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 and either:

- press **Try it with sample data**, pick a role and open the dashboard; or
- use a demo link, which loads the sample and signs you in:
  - http://localhost:3000/?sample=1&as=ceo: leadership
  - http://localhost:3000/?sample=1&as=SR1: branch manager, Downtown Toyota
  - http://localhost:3000/?sample=1&as=SR13: sales rep

Other commands:

```bash
npm run typecheck   # TypeScript check
npm test            # anomaly-maths unit tests
npm run build       # production build (stop `npm run dev` first; both use .next/)
npm start           # serve the production build on :3000
```

To use the API, create `frontend/.env.local` before running `npm run dev`. Next.js only reads it at startup, so restart the dev server after changing it.

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Delete the file, or leave the value empty, to go back to browser-only mode.

## 3. API (http://localhost:8000)

### Option A: Python

**Windows (PowerShell)**

```powershell
cd API
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
# Put a secret in .env:  JWT_SECRET=<output of the next command>
python -c "import secrets; print(secrets.token_urlsafe(48))"
flask --app wsgi run --port 8000
```

**macOS and Linux**

```bash
cd API
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
echo "JWT_SECRET=$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" >> .env
flask --app wsgi run --port 8000
```

Run the tests with `pytest -q`. There are 31; each run uses its own temporary database.

### Option B: Docker

```bash
cd API
cp .env.example .env            # Windows: Copy-Item .env.example .env
# set JWT_SECRET in .env (see Option A for a generator)
docker compose up --build
```

Docker keeps the database in a named volume, so changes survive restarts. `docker compose down -v` deletes the volume and returns to the bundled database.

### Try the API

**Health check:** open http://localhost:8000/api/health, which should show `{"status":"ok"}`.

**Sign in and call a few endpoints (PowerShell):**

```powershell
$login = Invoke-RestMethod -Method Post http://localhost:8000/api/auth/login -ContentType application/json `
  -Body '{"username":"Admin","password":"Admin$123"}'
$h = @{ Authorization = "Bearer $($login.access_token)" }

Invoke-RestMethod http://localhost:8000/api/auth/me -Headers $h
(Invoke-RestMethod "http://localhost:8000/api/leads?page=1&page_size=5&sort=-deal_value" -Headers $h).items
(Invoke-RestMethod "http://localhost:8000/api/users/candidates?page_size=5" -Headers $h).items | Select id,name,branch_name,login_role
(Invoke-RestMethod "http://localhost:8000/api/anomalies" -Headers $h).counts

# Create a login for the Downtown Toyota manager (SR1) and sign in as them
Invoke-RestMethod -Method Post http://localhost:8000/api/users -Headers $h -ContentType application/json `
  -Body '{"username":"kavitha","password":"Str0ng!pass","rep_id":"SR1"}'
$m = Invoke-RestMethod -Method Post http://localhost:8000/api/auth/login -ContentType application/json `
  -Body '{"username":"kavitha","password":"Str0ng!pass"}'
$mh = @{ Authorization = "Bearer $($m.access_token)" }
(Invoke-RestMethod http://localhost:8000/api/dataset -Headers $mh).branches   # only Downtown Toyota
```

**The same, with curl (macOS, Linux, or Git Bash):**

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"Admin","password":"Admin$123"}' | python -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s "localhost:8000/api/leads?page_size=3" -H "Authorization: Bearer $TOKEN"
```

**Watch the notification stream:**

```bash
TICKET=$(curl -s -X POST localhost:8000/api/notifications/stream-ticket -H "Authorization: Bearer $TOKEN" \
  | python -c 'import sys,json; print(json.load(sys.stdin)["ticket"])')
curl -N "localhost:8000/api/notifications/stream?ticket=$TICKET"
```

Each unread notice arrives as an `event: notice` line, followed by `event: sync`.

Every endpoint is listed in [API/README.md](./API/README.md).

### Resetting the API database

```bash
cd API
python scripts/reset_db.py                # back to: Admin / Admin$123 + sample data
python scripts/reset_db.py --keep-users   # reload the sample sales data, keep logins and reviews
```

Running the API locally writes to `API/data/dealerpulse.db`. Run `git checkout API/data/dealerpulse.db` if you don't want to commit your test changes.

## 4. The database address

`API/.env` names the bundled SQLite database explicitly. The path is relative to the `API` folder, and Docker resolves it to `/app/data/dealerpulse.db`:

```
DATABASE_URL=sqlite:///data/dealerpulse.db
```

## 5. Use the web app with the API

1. Start the API (step 3) and the web app with `frontend/.env.local` (step 2).
2. Open http://localhost:3000 and sign in as **Admin / Admin$123**. Leadership lands on the network overview.
3. Open **Data and logins** in the top navigation:
   - **Create a login:** choose *Someone in the data* (for example Kavitha Sharma, Downtown Toyota manager, or Suresh Pillai, sales rep). Or choose *A new person* to add someone to a branch, or *Leadership*. Set a username and a starting password, such as `Str0ng!pass`.
   - **Upload a new file:** pick a JSON file. The server checks it first. If there are problems, the current data stays live and the problems are listed in plain language.
   - **Manage logins:** reset passwords, unlock locked logins, turn logins off or on, or delete them.
4. Sign out (profile menu, top right), then sign in with the new login:
   - A **manager** lands on their own branch and can't open other branches.
   - A **rep** lands on their own sales.
   - Unread notifications pop up one after another, streamed live from the API.
5. **Change password** is in the profile menu. Change the Admin password before anyone else uses the system.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` or `pip install` fails with `EPERM`, `ENOTEMPTY` or "file is being used by another process" (Windows) | An IDE file watcher or antivirus is locking new files. Close the IDE and retry, or create the Python venv outside the project, e.g. `python -m venv C:\venvs\dealerpulse`. |
| The web app returns 500 errors after a build | `npm run build` and `npm run dev` share `.next/`. Stop the dev server, delete `frontend/.next`, then start `npm run dev` again. |
| Port 3000 or 8000 already in use | Web app: `npx next dev -p 3001`. API: `flask --app wsgi run --port 8001`, then add `http://localhost:3001` to `CORS_ORIGINS` if the web app calls it. |
| API: `JWT_SECRET is too short` or `must be set in production` | Put a secret of at least 32 characters in `API/.env`. Without one, development mode makes a random secret, which signs everyone out on each restart. |
| API: login says "Too many failed attempts" | 5 wrong passwords lock that login for 15 minutes. Wait, or have Admin unlock it: `PATCH /api/users/{id}` with `{"unlock": true}`. |
| API: `429 Too Many Requests` | You've hit a rate limit (login: 10 per minute). Wait a minute. |
| API: "Your login isn't linked to anyone in the current data" | An upload removed that person. Recreate the login for someone in the current data. |
| Docker: "failed to connect to the docker API" | Start Docker Desktop and wait until it says the engine is running. |
| Web app: "Can't reach the DealerPulse server" on sign-in | The API isn't running, or `NEXT_PUBLIC_API_URL` is wrong. Check http://localhost:8000/api/health, then restart `npm run dev` after editing `.env.local`. |
| Web app: the browser blocks API calls (CORS error in the console) | Add the web app's address, e.g. `http://localhost:3000`, to `CORS_ORIGINS` in `API/.env`, then restart the API. |
| Signed out unexpectedly | Sessions last 30 minutes and renew while the tab is open. Closing the tab, a password change, or Admin turning off the login all sign you out. |
