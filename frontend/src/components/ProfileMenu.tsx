"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useDashboard, useStore } from "@/lib/store";
import { ThemePref, useTheme } from "@/lib/theme";
import { homeFor, initials, ROLE_LABEL } from "@/lib/user";
import { PasswordDialog } from "./PasswordDialog";
import { useDismiss } from "./ui";

export function ProfileMenu({ onReplayTour }: { onReplayTour: () => void }) {
  const { model, user } = useDashboard();
  const { setUser, clear, apiMode, signOut } = useStore();
  const [pwOpen, setPwOpen] = useState(false);
  const { pref, setPref } = useTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const branch = user.branchId ? model.branchById.get(user.branchId) : undefined;
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <div className="popover-wrap" ref={ref} data-tour="profile">
      <button className="avatar-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
        <span className="avatar-meta">
          <span className="avatar-name">{user.name}</span>
          <span className="avatar-role">{ROLE_LABEL[user.role]}</span>
        </span>
      </button>

      {open && (
        <div className="popover profile" role="menu" aria-label="Your profile">
          <div className="profile-head">
            <span className="avatar avatar-lg" aria-hidden="true">{initials(user.name)}</span>
            <div>
              <strong>{user.name}</strong>
              <p className="subtle">{ROLE_LABEL[user.role]}{branch ? ` · ${branch.name}` : " · All branches"}</p>
            </div>
          </div>
          <button role="menuitem" className="menu-item" onClick={() => go(homeFor(user))}>Go to my dashboard</button>
          {apiMode
            ? <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); setPwOpen(true); }}>Change password</button>
            : <button role="menuitem" className="menu-item" onClick={() => go("/?step=role")}>Switch role or person</button>}
          {apiMode && user.role === "ceo" && <button role="menuitem" className="menu-item" onClick={() => go("/dashboard/admin")}>Data and logins</button>}
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); onReplayTour(); }}>Show me around again</button>
          <div className="menu-group" role="group" aria-label="Appearance">
            <span className="menu-label">Appearance</span>
            <div className="seg seg-full">
              {(["system", "light", "dark"] as ThemePref[]).map((p) => (
                <button key={p} className={pref === p ? "on" : ""} aria-pressed={pref === p} onClick={() => setPref(p)}>
                  {p === "system" ? "Auto" : p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="menu-sep" />
          {!apiMode && <button role="menuitem" className="menu-item" onClick={() => { clear(); go("/"); }}>Upload a different file</button>}
          <button role="menuitem" className="menu-item danger" onClick={() => {
            if (apiMode) { setOpen(false); signOut().then(() => router.replace("/")); }
            else { setUser(null); go("/?step=role"); }
          }}>Sign out</button>
        </div>
      )}
      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
    </div>
  );
}
