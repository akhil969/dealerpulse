"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty } from "@/components/ui";
import { api, apiEnabled, ApiError, Candidate, LoginRow, Paged } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import { useDashboard, useStore } from "@/lib/store";
import { ROLE_LABEL } from "@/lib/user";
import type { ValidationIssue } from "@/lib/validate";

const PAGE = 20;

export default function AdminPage() {
  const { user } = useDashboard();
  if (!apiEnabled) return <Empty>Data and login management needs the DealerPulse server. Set NEXT_PUBLIC_API_URL to use it.</Empty>;
  if (user.role !== "ceo") return <Empty>Only leadership can manage data and logins.</Empty>;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Data and logins</h1>
          <p>Upload the latest sales file and decide who can sign in. Everyone only ever sees their own branch or their own customers.</p>
        </div>
      </div>
      <DataCard />
      <Logins />
    </div>
  );
}

// ---------- Data upload ----------

function DataCard() {
  const { datasetInfo, reloadFromApi } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "ok"; msg: string; warnings: ValidationIssue[]; unlinked: string[] } | { kind: "bad"; msg: string; issues: ValidationIssue[] }>({ kind: "idle" });

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setState({ kind: "busy" });
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      setState({ kind: "bad", msg: `${f.name} isn't valid JSON. Usually this is a missing comma, quote or bracket.`, issues: [] });
      return;
    }
    try {
      const r = await api.upload(data, f.name);
      await reloadFromApi();
      setState({ kind: "ok", msg: `${f.name} is now the live data: ${r.counts.leads} leads, ${r.counts.branches} branches, ${r.counts.sales_reps} people.`, warnings: r.warnings, unlinked: r.unlinked_logins });
    } catch (err) {
      const d = err instanceof ApiError ? (err.details as { errors?: ValidationIssue[] } | undefined) : undefined;
      setState({ kind: "bad", msg: err instanceof Error ? err.message : "Upload failed.", issues: d?.errors ?? [] });
    }
  }

  return (
    <Card title="Sales data" subtitle="Uploading replaces the data for everyone. Logins, reviews and the audit log are kept."
      actions={<button className="btn btn-primary btn-sm" onClick={() => input.current?.click()} disabled={state.kind === "busy"}>
        {state.kind === "busy" ? "Checking…" : "Upload a new file"}</button>}>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={onPick} />
      {datasetInfo?.loaded ? (
        <p className="muted">
          Live now: <strong>{datasetInfo.source_name}</strong>, uploaded {datasetInfo.uploaded_at ? dateLabel(datasetInfo.uploaded_at) : ""} by {datasetInfo.uploaded_by}
          {datasetInfo.counts ? ` · ${datasetInfo.counts.leads} leads · ${datasetInfo.counts.branches} branches · ${datasetInfo.counts.sales_reps} people` : ""}.
        </p>
      ) : <p className="muted">No data loaded yet.</p>}
      {state.kind === "ok" && (
        <div className="notice notice-ok" role="status" style={{ marginTop: 10 }}>
          <strong>Upload complete.</strong> <span className="muted">{state.msg}</span>
          {state.unlinked.length > 0 && <p className="muted">These logins no longer match anyone in the data and can&apos;t sign in: {state.unlinked.join(", ")}.</p>}
          {state.warnings.length > 0 && <p className="subtle">{state.warnings.length} thing(s) worth double-checking, e.g. {state.warnings[0].where} {state.warnings[0].message}.</p>}
        </div>
      )}
      {state.kind === "bad" && (
        <div className="notice notice-bad" role="alert" style={{ marginTop: 10 }}>
          <strong>The file wasn&apos;t used.</strong> <span className="muted">{state.msg} The current data is unchanged.</span>
          {state.issues.length > 0 && (
            <ul className="issues">
              {state.issues.slice(0, 50).map((e, i) => <li key={i}><strong>{e.where}</strong> {e.message}. <code className="issue-path">{e.path}</code></li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------- Logins ----------

function Logins() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [data, setData] = useState<Paged<LoginRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.users({ page, page_size: PAGE, q: q || undefined }).then(setData).catch((e) => setError(e.message));
  }, [page, q]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof ApiError && Array.isArray(e.details) ? `${e.message} ${(e.details as string[]).join(" ")}` : e instanceof Error ? e.message : "That didn't work.");
    }
  }

  return (
    <>
      <CreateLogin onCreated={load} />
      <Card title="Logins" subtitle={data ? `${data.total} login${data.total === 1 ? "" : "s"}` : undefined}
        actions={<input type="text" placeholder="Search name or username" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search logins" />}>
        {error && <div className="notice notice-bad" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
        {!data ? <div className="skeleton" style={{ height: 160 }} /> : data.items.length === 0 ? <Empty>No logins match.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th className="num">Actions</th></tr></thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id}>
                    <td className="cell-strong">{u.display_name}<div className="subtle">{u.rep_id ?? "All branches"}{u.branch_id ? ` · ${u.branch_id}` : ""}</div></td>
                    <td><code>{u.username}</code></td>
                    <td>{ROLE_LABEL[u.role]}</td>
                    <td>{!u.active ? <span className="badge">Off</span> : u.locked ? <span className="badge badge-bad">Locked</span> : <span className="badge badge-good">Active</span>}</td>
                    <td className="subtle">{u.last_login_at ? dateLabel(u.last_login_at) : "Never"}</td>
                    <td className="num">
                      <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                        {u.locked && <button className="btn btn-sm" onClick={() => act(() => api.updateUser(u.id, { unlock: true }))}>Unlock</button>}
                        <button className="btn btn-sm" onClick={() => {
                          const pw = window.prompt(`New password for ${u.username} (8+ characters, mix of letters, numbers and symbols):`);
                          if (pw) act(() => api.updateUser(u.id, { password: pw }));
                        }}>Reset password</button>
                        <button className="btn btn-sm" disabled={u.username === "admin"} onClick={() => act(() => api.updateUser(u.id, { active: !u.active }))}>
                          {u.active ? "Turn off" : "Turn on"}
                        </button>
                        <button className="btn btn-sm" disabled={u.username === "admin"} onClick={() => {
                          if (window.confirm(`Delete the login ${u.username}? The person stays in the data.`)) act(() => api.deleteUser(u.id));
                        }}>Delete</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="subtle">Page {data.page} of {data.pages}</span>
            <button className="btn btn-sm" disabled={!data.has_next} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </Card>
    </>
  );
}

type Mode = "existing" | "new" | "ceo";

function CreateLogin({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<Mode>("existing");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string; city: string }[]>([]);
  const [repId, setRepId] = useState("");
  const [person, setPerson] = useState({ name: "", branch_id: "", role: "sales_officer" as "sales_officer" | "branch_manager" });
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCandidates = useCallback(() => {
    api.candidates({ page_size: 200 }).then((r) => setCandidates(r.items)).catch(() => setCandidates([]));
  }, []);
  useEffect(() => {
    loadCandidates();
    api.branches().then((r) => setBranches(r.items)).catch(() => {});
  }, [loadCandidates]);

  // Suggest a username from the chosen person's name.
  useEffect(() => {
    const name = mode === "existing" ? candidates.find((c) => c.id === repId)?.name : mode === "new" ? person.name : displayName;
    if (name) setUsername(name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 32));
  }, [mode, repId, person.name, displayName, candidates]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body: Record<string, unknown> = { username, password };
    if (mode === "existing") body.rep_id = repId;
    if (mode === "new") body.new_person = person;
    if (mode === "ceo") Object.assign(body, { role: "ceo", display_name: displayName });
    try {
      const u = await api.createUser(body);
      setMsg({ ok: true, text: `Created ${u.username} (${ROLE_LABEL[u.role]}). Share the password with ${u.display_name} securely.` });
      setPassword("");
      setRepId("");
      setPerson({ name: "", branch_id: "", role: "sales_officer" });
      loadCandidates();
      onCreated();
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? ` ${(err.details as string[]).join(" ")}` : "";
      setMsg({ ok: false, text: (err instanceof Error ? err.message : "That didn't work.") + details });
    }
  }

  const byBranch = branches.map((b) => ({ b, people: candidates.filter((c) => c.branch_id === b.id) })).filter((x) => x.people.length);

  return (
    <Card title="Create a login" subtitle="Managers see only their branch. Sales reps see only their own customers.">
      <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
        <div className="seg" role="radiogroup" aria-label="Who is this login for?">
          {([["existing", "Someone in the data"], ["new", "A new person"], ["ceo", "Leadership"]] as [Mode, string][]).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>

        <div className="grid admin-form">
          {mode === "existing" && (
            <label className="field">
              <span>Person ({candidates.length} without a login)</span>
              <select value={repId} onChange={(e) => setRepId(e.target.value)} required>
                <option value="">Choose a person…</option>
                {byBranch.map(({ b, people }) => (
                  <optgroup key={b.id} label={`${b.name}, ${b.city}`}>
                    {people.map((c) => <option key={c.id} value={c.id}>{c.name} · {ROLE_LABEL[c.login_role]}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          {mode === "new" && (
            <>
              <label className="field"><span>Full name</span>
                <input type="text" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} required minLength={2} maxLength={120} />
              </label>
              <label className="field"><span>Branch</span>
                <select value={person.branch_id} onChange={(e) => setPerson({ ...person, branch_id: e.target.value })} required>
                  <option value="">Choose a branch…</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}, {b.city}</option>)}
                </select>
              </label>
              <label className="field"><span>Job</span>
                <select value={person.role} onChange={(e) => setPerson({ ...person, role: e.target.value as typeof person.role })}>
                  <option value="sales_officer">Sales rep</option>
                  <option value="branch_manager">Branch manager</option>
                </select>
              </label>
            </>
          )}
          {mode === "ceo" && (
            <label className="field"><span>Name</span>
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={120} />
            </label>
          )}
          <label className="field"><span>Username</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required minLength={3} maxLength={32} pattern="[a-z0-9][a-z0-9._\-]{2,31}" />
          </label>
          <label className="field"><span>Starting password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" />
          </label>
        </div>
        <p className="subtle">Passwords need 8+ characters and at least three of: lower-case, upper-case, numbers, symbols.</p>
        {msg && <div className={`notice ${msg.ok ? "notice-ok" : "notice-bad"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
        <div><button className="btn btn-primary" type="submit">Create login</button></div>
      </form>
    </Card>
  );
}
