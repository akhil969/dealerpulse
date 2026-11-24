"use client";

import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { SchemaView } from "@/components/SchemaView";
import { api, apiEnabled } from "@/lib/api";
import { useStore } from "@/lib/store";
import { TEMPLATE } from "@/lib/template";
import { homeFor, Role, User } from "@/lib/user";
import { parseAndValidate, validateDealershipData, ValidationIssue, ValidationResult } from "@/lib/validate";

const MAX_BYTES = 20 * 1024 * 1024;

type FileState =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; fileName: string; result: ValidationResult };

const fail = (fileName: string, where: string, message: string): FileState => ({
  kind: "done", fileName,
  result: { ok: false, errorCount: 1, warnings: [], errors: [{ path: "file", where, section: "The file", message }] },
});

const SECTIONS = [
  { name: "Branches", what: "Each showroom: a short code, its name and city.", eg: "B1 · Downtown Toyota · Chennai" },
  { name: "Sales team", what: "Everyone who sells, which branch they work at and whether they manage it.", eg: "SR1 · Kavitha Sharma · B1 · branch manager" },
  { name: "Leads", what: "Every customer enquiry: who they are, the car they want, who's handling it, its value, and each step it went through.", eg: "L0002 · Hema Rajan · Innova Hycross · new → contacted → lost" },
  { name: "Monthly targets", what: "How many cars and how much revenue each branch should sell each month.", eg: "B1 · 2025-06 · 39 cars · ₹8.7 Cr" },
  { name: "Deliveries", what: "Cars handed over: order date, delivery date and the reason for any delay.", eg: "L0001 · ordered 17 Jul · delivered 3 Aug" },
];

export default function StartPage() {
  const { apiMode } = useStore();
  return apiMode ? <SignInScreen /> : <LocalStart />;
}

function SignInScreen() {
  const router = useRouter();
  const { signIn, user, hydrated } = useStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && user) router.replace(homeFor(user));
  }, [hydrated, user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await signIn(username.trim(), password);
      router.push(homeFor(u));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="start">
      <header className="topbar">
        <div className="topbar-inner"><Brand /></div>
      </header>
      <main className="start-main" id="main">
        <div className="signin-wrap">
          <section className="start-hero signin-hero">
            <p className="eyebrow">Sales dashboard for dealer groups</p>
            <h1>See which branches are behind, which customers are going quiet, and what to do next.</h1>
            <p className="lede">Sign in with the login your administrator gave you. You'll see your own branch or your own customers, and the alerts that are yours to act on.</p>
          </section>
          <form className="step is-active signin" onSubmit={submit} aria-labelledby="signin-title">
            <h2 id="signin-title">Sign in</h2>
            <label className="field">
              <span>Username</span>
              <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} autoFocus />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} />
            </label>
            {error && <div className="notice notice-bad" role="alert">{error}</div>}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !username || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="subtle">No login yet? Ask your administrator to create one for you.</p>
            {process.env.NODE_ENV !== "production" && (
              <p className="subtle signin-hint">Pilot setup: the administrator signs in as <code>Admin</code> / <code>Admin$123</code>.</p>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}

function LocalStart() {
  const router = useRouter();
  const { load, hasData: loaded, roster, fileName, user, setUser, clear } = useStore();
  const [file, setFile] = useState<FileState>({ kind: "idle" });
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLElement>(null);

  function finish(name: string, result: ValidationResult) {
    setFile({ kind: "done", fileName: name, result });
    if (result.ok && result.data) {
      load(result.data, name);
      setTimeout(() => roleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }

  async function handleFile(f: File) {
    if (!f.name.toLowerCase().endsWith(".json") && f.type !== "application/json") {
      return setFile(fail(f.name, "The file", "isn't a JSON file. Export your data as .json and try again."));
    }
    if (f.size > MAX_BYTES) {
      return setFile(fail(f.name, "The file", `is ${(f.size / 1048576).toFixed(1)} MB. Files can be up to 20 MB.`));
    }
    setFile({ kind: "busy", label: `Checking ${f.name}…` });
    const text = await f.text();
    requestAnimationFrame(() => finish(f.name, parseAndValidate(text))); // let the spinner paint first
  }

  async function loadSample() {
    setFile({ kind: "busy", label: "Loading the sample data…" });
    try {
      const res = await fetch("/sample-data.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      finish("Sample dealership data", parseAndValidate(await res.text()));
    } catch {
      setFile(fail("Sample data", "Sample data", "couldn't be loaded. Check your connection and try again."));
    }
  }

  async function loadFromServer() {
    setFile({ kind: "busy", label: "Getting the latest data from the company server…" });
    try {
      finish("Company server", validateDealershipData(await api.getDataset()));
    } catch {
      setFile(fail("Company server", "Company server", "didn't respond. Try again, or upload a file instead."));
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(TEMPLATE, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "dealerpulse-template.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Deep links: /?step=role scrolls to step 2; /?sample=1[&as=ceo|SR13][&next=/dashboard/...] for demos.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("step") === "role") setTimeout(() => roleRef.current?.scrollIntoView({ block: "start" }), 100);
    if (qs.get("sample") === "1") loadSample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const as = qs.get("as");
    if (!roster || !as) return;
    const rep = roster.reps.find((r) => r.id === as);
    const u: User | null = as === "ceo" ? { role: "ceo", name: "Leadership team" }
      : rep ? { role: rep.role === "branch_manager" ? "manager" : "rep", name: rep.name, repId: rep.id, branchId: rep.branch_id } : null;
    if (!u) return;
    setUser(u);
    const next = qs.get("next") ?? "";
    router.push(/^\/dashboard(\/[\w/-]*)?(\?[\w=&-]*)?$/.test(next) ? next : homeFor(u));
  }, [roster, router, setUser]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  };

  const hasData = loaded && !!roster;
  const result = file.kind === "done" ? file.result : null;

  return (
    <div className="start">
      <header className="topbar">
        <div className="topbar-inner"><Brand /></div>
      </header>

      <main className="start-main" id="main">
        <section className="start-hero">
          <p className="eyebrow">Sales dashboard for dealer groups</p>
          <h1>See which branches are behind, which customers are going quiet, and what to do next.</h1>
          <p className="lede">
            Add your sales file and tell us who you are. DealerPulse turns it into a dashboard built for your role.
            The file stays on this computer. It is never uploaded anywhere.
          </p>
        </section>

        <div className="start-grid">
          <ol className="steps">
            {/* Step 1 */}
            <li className={`step ${hasData ? "is-done" : "is-active"}`}>
              <div className="step-head">
                <span className="step-num" aria-hidden="true">{hasData ? "✓" : "1"}</span>
                <div>
                  <h2>Add your sales data</h2>
                  <p className="muted">A JSON export with your branches, team, leads, targets and deliveries.</p>
                </div>
              </div>

              {hasData && file.kind !== "busy" && !(result && !result.ok) ? (
                <div className="file-ok">
                  <div>
                    <strong>{fileName}</strong>
                    <p className="muted">
                      {roster!.branches.length} branches · {roster!.reps.length} people · {roster!.counts.leads.toLocaleString()} leads ·{" "}
                      {roster!.counts.months} months of targets
                    </p>
                  </div>
                  <button className="btn btn-sm" onClick={() => { clear(); setFile({ kind: "idle" }); }}>Use a different file</button>
                </div>
              ) : (
                <>
                  <div
                    className={`dropzone${drag ? " drag" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label="Choose a JSON file to upload"
                    onClick={() => input.current?.click()}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
                    onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={onDrop}
                  >
                    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <strong>Drop your file here, or click to choose one</strong>
                    <span className="subtle">JSON file, up to 20 MB</span>
                    <input ref={input} type="file" accept=".json,application/json" hidden onChange={onPick} />
                  </div>
                  <div className="row start-alt">
                    <span className="subtle">No file yet?</span>
                    <button className="btn btn-sm" onClick={loadSample} disabled={file.kind === "busy"}>Try it with sample data</button>
                    {apiEnabled && <button className="btn btn-sm" onClick={loadFromServer} disabled={file.kind === "busy"}>Get data from company server</button>}
                  </div>
                </>
              )}

              {file.kind === "busy" && <div className="notice row" role="status"><span className="spinner" /> {file.label}</div>}
              {result && <FileResult result={result} fileName={file.kind === "done" ? file.fileName : ""} onTemplate={downloadTemplate} />}
            </li>

            {/* Step 2 */}
            <li className={`step ${!hasData ? "is-locked" : user ? "is-done" : "is-active"}`} ref={roleRef as React.RefObject<HTMLLIElement>}>
              <div className="step-head">
                <span className="step-num" aria-hidden="true">{hasData && user ? "✓" : "2"}</span>
                <div>
                  <h2>Tell us who you are</h2>
                  <p className="muted">We&apos;ll open the right view for you and only alert you about things you can act on.</p>
                </div>
              </div>
              {hasData ? <RolePicker /> : <p className="subtle step-wait">Available once your data is added.</p>}
            </li>

            {/* Step 3 */}
            <li className={`step ${hasData && user ? "is-active" : "is-locked"}`}>
              <div className="step-head">
                <span className="step-num" aria-hidden="true">3</span>
                <div>
                  <h2>Open your dashboard</h2>
                  <p className="muted">The first time, we&apos;ll show you around in about a minute.</p>
                </div>
              </div>
              <button className="btn btn-primary btn-lg" disabled={!hasData || !user} onClick={() => user && router.push(homeFor(user))}>
                {user ? `Open ${user.role === "ceo" ? "the network overview" : user.role === "manager" ? "my branch" : "my sales"}` : "Open my dashboard"}
              </button>
            </li>
          </ol>

          <aside className="guide" aria-labelledby="guide-title">
            <h2 id="guide-title">What goes in the file?</h2>
            <p className="muted">Five sections. Most dealer management systems can export these as JSON. If yours can&apos;t, the template shows the exact layout to copy.</p>
            <ul className="guide-list">
              {SECTIONS.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong>
                  <span>{s.what}</span>
                  <span className="guide-eg">e.g. {s.eg}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <button className="btn btn-sm" onClick={downloadTemplate}>Download a template</button>
            </div>
            <details className="tech">
              <summary>Show the exact format (for your IT team)</summary>
              <SchemaView />
            </details>
          </aside>
        </div>
      </main>
    </div>
  );
}

function RolePicker() {
  const { roster, user, setUser } = useStore();
  const [role, setRole] = useState<Role | null>(user?.role ?? null);
  const [ceoName, setCeoName] = useState(user?.role === "ceo" ? user.name : "");
  const [person, setPerson] = useState(user?.repId ?? "");

  const people = useMemo(() => {
    if (!roster) return [];
    return roster.branches.map((b) => ({
      branch: b,
      reps: roster.reps.filter((r) => r.branch_id === b.id && (role === "manager" ? r.role === "branch_manager" : r.role === "sales_officer")),
    }));
  }, [roster, role]);
  if (!roster) return null;

  const choose = (r: Role) => {
    setRole(r);
    setPerson("");
    if (r === "ceo") setUser({ role: "ceo", name: ceoName.trim() || "Leadership team" });
    else setUser(null);
  };
  const pickPerson = (id: string) => {
    setPerson(id);
    const rep = roster.reps.find((r) => r.id === id);
    setUser(rep && role ? { role, name: rep.name, repId: rep.id, branchId: rep.branch_id } : null);
  };

  const ROLES: { id: Role; title: string; body: string }[] = [
    { id: "ceo", title: "Leadership", body: "Every branch side by side, targets, and where the business is losing deals." },
    { id: "manager", title: "Branch manager", body: "Your branch against target, how each person is doing, and who needs a nudge." },
    { id: "rep", title: "Sales rep", body: "Your customers, your orders, and who to call today." },
  ];

  return (
    <div className="role-pick">
      <div className="role-cards" role="radiogroup" aria-label="Your role">
        {ROLES.map((r) => (
          <button key={r.id} role="radio" aria-checked={role === r.id} className={`role-card${role === r.id ? " on" : ""}`} onClick={() => choose(r.id)}>
            <strong>{r.title}</strong>
            <span>{r.body}</span>
          </button>
        ))}
      </div>
      {role === null ? null : role === "ceo" ? (
        <label className="field">
          <span>Your name <span className="subtle">(optional)</span></span>
          <input type="text" value={ceoName} placeholder="Leadership team" onChange={(e) => {
            setCeoName(e.target.value);
            setUser({ role: "ceo", name: e.target.value.trim() || "Leadership team" });
          }} />
        </label>
      ) : (
        <label className="field">
          <span>{role === "manager" ? "Which branch do you manage?" : "Which one is you?"}</span>
          <select value={person} onChange={(e) => pickPerson(e.target.value)}>
            <option value="">{role === "manager" ? "Choose your branch…" : "Choose your name…"}</option>
            {people.map(({ branch, reps }) =>
              role === "manager"
                ? reps.map((r) => <option key={r.id} value={r.id}>{branch.name}, {branch.city} ({r.name})</option>)
                : reps.length > 0 && (
                    <optgroup key={branch.id} label={`${branch.name}, ${branch.city}`}>
                      {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </optgroup>
                  ),
            )}
          </select>
        </label>
      )}
    </div>
  );
}

function groupBySection(items: ValidationIssue[]) {
  const map = new Map<string, ValidationIssue[]>();
  items.forEach((i) => map.set(i.section, [...(map.get(i.section) ?? []), i]));
  return [...map.entries()];
}

function FileResult({ result, fileName, onTemplate }: { result: ValidationResult; fileName: string; onTemplate: () => void }) {
  if (result.ok) {
    return (
      <div className="notice notice-ok" role="status">
        <strong>Your data looks good.</strong>{" "}
        <span className="muted">Everything we need is there and all the records match up.</span>
        {result.warnings.length > 0 && (
          <details className="issues-wrap">
            <summary>{result.warnings.length} thing{result.warnings.length === 1 ? "" : "s"} worth double-checking (these won&apos;t stop you)</summary>
            <IssueList items={result.warnings} />
          </details>
        )}
      </div>
    );
  }
  const groups = groupBySection(result.errors);
  return (
    <div className="notice notice-bad" role="alert">
      <strong>We couldn&apos;t use {fileName || "this file"} yet.</strong>
      <p className="muted">
        We found {result.errorCount} thing{result.errorCount === 1 ? "" : "s"} to fix
        {groups.length > 1 ? ` in ${groups.map(([s, l]) => `${s} (${l.length})`).join(", ")}` : ""}.
        Fix them in your file and add it again.
        {result.errorCount > result.errors.length ? ` We're showing the first ${result.errors.length}.` : ""}
      </p>
      <IssueList items={result.errors} />
      <p className="subtle">
        Not sure what the file should look like? <button className="link-btn" onClick={onTemplate}>Download a template</button> to compare.
      </p>
    </div>
  );
}

function IssueList({ items }: { items: ValidationIssue[] }) {
  return (
    <ul className="issues">
      {items.map((e, i) => (
        <li key={i}>
          <strong>{e.where}</strong> {e.message}.
          <code className="issue-path" title="Exact location in the file">{e.path}</code>
        </li>
      ))}
    </ul>
  );
}
