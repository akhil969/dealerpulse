# Security: OWASP Top 10 (2021) mapping

This file shows how the DealerPulse API addresses each OWASP Top 10 category, and where the code is. Items marked **POC** are deliberate shortcuts for the proof of concept, with what to change before real use.

## A01 Broken Access Control
- **Deny by default.** Every route except health and login needs `@authenticated` or `@roles(...)` (`interfaces/http/auth.py`).
- **The role comes from the server, never from the request.** It is read from the user record on every request (`AuthService.authenticate`). Managers and reps get their branch from the current data, not from the token.
- **Row-level scope is applied on the server.** It's in the SQL `WHERE` for lists (`QueryService._scope`, `SqlDatasetRepo.list_leads`) and in `domain/access.scope_dataset` for full data. Request filters intersect with the scope and can't widen it (tested: `test_filters_cannot_widen_scope`).
- **Field-level rules** mask or hide fields before anything is serialised (`domain/access.FIELD_RULES`).
- **Object-level checks:** a lead, finding or review outside your scope returns 404, which doesn't reveal that it exists (`test_object_level_checks_return_404`).
- **Admin functions** (users, upload, audit) are leadership-only, checked both on the route and inside the service.
- **Reviews** need the finding to be in your own live view, plus `can_review`. A manager can't review another branch.

## A02 Cryptographic Failures
- **Password hashing:** scrypt, which is memory-hard (`infrastructure/security.py`). Passwords are never logged or returned.
- **Tokens:** HS256 JWTs. The algorithm is pinned, which rejects `alg=none` and algorithm-confusion tokens (tested). `exp`, `iat`, `aud` and `iss` are required.
- **The secret** comes only from `JWT_SECRET`. Production refuses to start without one, and anything under 32 characters is rejected.
- **Customer phone numbers** are masked for leadership, and responses with personal data are sent with `Cache-Control: no-store`.
- **HTTPS:** set `HTTPS_ONLY=true` behind TLS to send HSTS. TLS itself is handled by the host (Vercel or a reverse proxy).
- **POC:** the SQLite file isn't encrypted at rest. Use the hosted database's encryption, or full-disk encryption, for real data.

## A03 Injection
- **SQL:** every query goes through SQLAlchemy expressions with bound parameters, with no string-built SQL. User search terms have `%`/`_` escaped, so they match literally (tested).
- **Input:** every request body and query string is validated by pydantic models (`interfaces/http/schemas.py`):
  - unknown fields are rejected (`extra="forbid"`);
  - strings are length-capped, and ids are pattern-restricted;
  - sort keys are an allow-list;
  - enums are checked.
- **Uploads:** the file is parsed as JSON only, never executed or evaluated, and validated field by field (`domain/validation.py`).

## A04 Insecure Design
- **Rate limits:**
  - 300 requests per minute per IP by default;
  - login 10 per minute;
  - upload 10 per minute;
  - stream tickets 30 per minute (`interfaces/http/limits.py`).
- **Lockout:** 5 failed logins lock that account for 15 minutes.
- **Size caps:** request bodies are limited by `MAX_UPLOAD_MB` (20 MB, refused before parsing), and pages by `page_size ≤ 200`.
- **Reviews:** anomaly findings are only ever flagged. A person must confirm each one, and every decision is recorded with who, when and why.

## A05 Security Misconfiguration
- **Security headers on every response:** a strict CSP (`default-src 'none'`), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and the COOP and CORP headers (`interfaces/http/middleware.py`).
- **CORS** is an explicit allow-list (`CORS_ORIGINS`), without credentials (tested).
- **No debug mode in production.** Unexpected errors return a generic message plus a request id, never a stack trace or SQL. The detail goes to the server log.
- **Docker:** the image runs as a non-root user (uid 10001) and is built on a slim base image.
- **POC:** the default `Admin$123` password is seeded as requested, and the API logs a warning when it creates it. Change it on first use, or remove the seeding in `bootstrap()`.

## A06 Vulnerable and Outdated Components
- **Pinned versions:** every dependency is pinned in `requirements.txt`.
- **Audit:** `pip-audit -r requirements.txt` (in `requirements-dev.txt`) checks them against known vulnerabilities. Run it in CI.
- **Few dependencies:** Flask, SQLAlchemy, PyJWT, pydantic, flask-cors, flask-limiter, gunicorn, python-dotenv, and psycopg (used only for PostgreSQL).

## A07 Identification and Authentication Failures
- **No user enumeration:**
  - wrong passwords and unknown usernames get the same message and status (tested);
  - a dummy hash is checked for unknown users, so both cases take the same time.
- **Password policy:** at least 8 characters, a mix of at least three character types, and it can't contain the username (`password_problems`).
- **Short-lived tokens** (30 minutes by default), with refresh.
- **Revocation:** logout, a password change, deactivation and an admin password reset all bump `token_version`, which revokes every existing token (tested).
- **Streams** use a separate 60-second ticket audience, so access tokens never appear in URLs. An access token is rejected as a ticket (tested).

## A08 Software and Data Integrity Failures
- **Uploads are validated before they change anything.** Validation covers the structure, types, allowed values, unique ids and references between records. The import runs in one transaction, so a failure leaves the old data untouched.
- **Versioning:** every upload creates a dataset version. Reviews are tied to the version they were made on.
- **Builds** are reproducible: pinned requirements and an explicit Dockerfile.

## A09 Security Logging and Monitoring Failures
- **The audit log** is stored in the `audit_log` table and readable by leadership at `GET /api/audit`. It records:
  - logins: success, failure and lockout;
  - logout and password changes;
  - logins created, updated or deleted;
  - uploads, accepted or rejected, with any unlinked logins;
  - every anomaly review.
- **Failures are kept.** Failed logins and rejected uploads are committed to the log before the error is returned, so a rollback can't erase them.
- **Request ids:** every response carries an `X-Request-ID`, and server errors are logged with it.
- **No sensitive values are logged:** passwords and tokens never appear in the log.

## A10 Server-Side Request Forgery
- The API never makes outbound requests based on user input. There are no URL fetches or webhooks, and uploads are request bodies, not URLs.

## Tests that cover these controls

`tests/test_api.py` covers:

- authentication and enumeration;
- lockout;
- token revocation;
- `alg=none` and tampered tokens;
- the password policy;
- leadership-only admin functions;
- unknown fields being rejected;
- row and field scoping per role;
- object-level 404s;
- filters that can't widen the scope;
- pagination bounds and the sort allow-list;
- LIKE escaping;
- upload validation;
- review permissions;
- stream tickets;
- security headers;
- the CORS allow-list;
- gzip.
