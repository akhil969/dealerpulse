# Role-based access control (frontend pilot)

DealerPulse is a frontend-only pilot. In the planned version the Flask API decides what each person may see. Until then, one module plays the part of that API: **`frontend/src/lib/access.ts`**. The uploaded or sample file is kept privately inside the data store (`frontend/src/lib/store.tsx`). Pages, charts, notifications and anomaly detection only ever receive the role-scoped copy that `scopeData()` returns.

```
uploaded / sample file ──► store (private, unscoped)
                              │
                    scopeData(file, user)   ◄── lib/access.ts  (row + field rules)
                              │
                    role-scoped model ──► every page, chart, notification, anomaly check
```

## 1. Row level: which records a role receives

| Role | Branches | People | Leads and deliveries | Targets |
|---|---|---|---|---|
| Leadership | all | all | all | all |
| Branch manager | own branch | own branch's team | own branch | own branch |
| Sales rep | own branch name only | self only | own leads only | none |

## 2. Field level: how each field is returned

`FIELD_RULES` in `access.ts` gives each field one of three rules per role:

- **full:** returned as is.
- **masked:** partly hidden. For example, a phone number keeps only its last 3 digits: `•••••••594`.
- **hidden:** removed. If a hidden field is the only useful content of a record, the record is dropped too.

| Field | Leadership | Manager | Rep | Why |
|---|---|---|---|---|
| `lead.customer_name` | full | full | full | Needed to act on a lead |
| `lead.phone` | **masked** | full | full | Leadership doesn't call customers; the people who do see the number |
| `lead.deal_value` | full | full | full | |
| `lead.status_history.note` | full | full | full | |
| `lead.lost_reason` | full | full | full | |
| `sales_rep.joined` | full | full | full | A rep only ever sees their own record |
| `target.target_units`, `target.target_revenue` | full | full | **hidden** | Targets are set per branch, so they're a manager's figures |
| `metadata.notes` | full | hidden | hidden | |

Fields not in the table are full for any role that can see the record. Masking happens before the data reaches any component, so CSV exports and printouts contain the masked values too.

## 3. Page level: which screens a role can open

| Page | Leadership | Manager | Rep |
|---|---|---|---|
| `/dashboard` (all branches) | ✓ | → own branch | → own sales |
| `/dashboard/branch/[id]` | any | own branch only | → own sales |
| `/dashboard/rep/[id]` | anyone | own team only | self only |
| `/dashboard/funnel` | ✓, with a branch picker | ✓, own branch | ✓, own leads |
| `/dashboard/followups` | ✓, with a branch picker | ✓, own branch | ✓, own list |
| `/dashboard/anomalies` | ✓ | ✓, own branch | confirmed findings about self |

`canOpen()` in `access.ts` applies these rules, and the dashboard layout enforces them. A page outside your scope sends you to your own home page.

The navigation follows the same rules:

- Only leadership sees the network overview and the branch picker.
- Managers and reps don't get an "All branches" link, breadcrumb or picker.
- A `?branch=` value in the URL is ignored for anyone except leadership.

## 4. Derived figures follow the same rule

Because every figure is computed from the scoped copy, totals, averages, rankings, notifications and anomaly findings only ever use rows the person may see. Two extra rules remove comparisons that would reveal people or branches outside the role's scope:

| Rule | Who | Effect |
|---|---|---|
| `seesBenchmarks` | Leadership only | Branch pages show "against X% across all branches" only for leadership |
| `seesPeers` | Leadership and managers | A rep's page shows no rank in the branch and no branch average |

"Today" and the month list come from the full file, so every role measures how long a customer has gone without contact from the same date, without seeing anyone else's records.

## 5. Anomaly reviews across roles

Detection runs on the scoped copy, so a manager's checks compare people within their branch and a rep has no detection of their own. When someone confirms or dismisses a finding, the review stores a snapshot of that finding. The snapshot lets a manager or rep see a confirmed finding about themselves even when their own view can't recompute it, for example a network-wide comparison that leadership confirmed. These findings are read-only: only findings in your own live view can be reviewed or reopened.

## 6. Limits of a frontend-only pilot (what moves to the API)

This is a pilot, not a security boundary:

- The uploaded file is still in the browser's `sessionStorage`, and the role is chosen rather than signed in. Anyone using the browser's developer tools can read the file and pick any role.
- The pilot shows the intended policy and keeps every screen honest about it. It doesn't stop a determined user on the same machine.

The Flask API in `API/` now implements this policy on the server (`API/dealerpulse/domain/access.py`):

1. **Real sign-in.** `Admin` creates a login for each manager and rep, and the role comes from the server's user record.
2. **Scoped data from the server.** `scope_dataset` and `FIELD_RULES` are the same rules ported to Python. `GET /api/dataset` and every list endpoint return only scoped data, and request filters can only narrow the scope.
3. **Server-side checks.** Single records outside your scope return 404, and review permissions are enforced on the server.

Once the frontend switches to the API, the browser never holds the full file and its `scopeData()` becomes a pass-through.

See `API.md` for the endpoint contract.

## 7. Verification

An automated browser check signed in as leadership, a branch manager (SR1, Downtown Toyota) and a sales rep (SR13). For each one it opened every navigation item plus pages outside the role's scope (other branches, other reps, `?branch=B3`). On every page, with the notification bell open, it scanned the visible text for any branch or person outside that role's scope.

Results:

- **Leaks:** no other branch or person appeared for any role.
- **Phone numbers:** masked for leadership, full for managers and reps.
- **Branch picker:** shown only to leadership.
- **Out-of-scope pages:** every one redirected to the person's own home page.
