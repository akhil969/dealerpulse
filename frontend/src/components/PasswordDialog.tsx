"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useStore } from "@/lib/store";

/** Change your own password. The server signs out every session afterwards, so this signs you in again. */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { signIn } = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords don't match." });
    setBusy(true);
    setMsg(null);
    try {
      const me = await api.me();
      await api.changePassword(current, next);
      await signIn(me.username, next); // old tokens were revoked by the change
      setMsg({ ok: true, text: "Password changed." });
      setTimeout(onClose, 900);
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? ` ${(err.details as string[]).join(" ")}` : "";
      setMsg({ ok: false, text: (err instanceof Error ? err.message : "That didn't work.") + details });
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="pw-title">
      <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
        <h2 id="pw-title">Change your password</h2>
        <label className="field"><span>Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" maxLength={128} />
        </label>
        <label className="field"><span>New password</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" maxLength={128} />
        </label>
        <label className="field"><span>New password again</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" maxLength={128} />
        </label>
        <p className="subtle">8+ characters, with at least three of: lower-case, upper-case, numbers, symbols.</p>
        {msg && <div className={`notice ${msg.ok ? "notice-ok" : "notice-bad"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
        </div>
      </form>
    </dialog>
  );
}
