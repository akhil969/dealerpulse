"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Brand } from "@/components/Brand";
import { NavCount } from "@/components/NavCount";
import { AnomalyProvider } from "@/lib/anomaly/store";
import { NavIcon, NavIconName } from "@/components/NavIcon";
import { NoticeProvider, NotificationBell } from "@/components/NotificationBell";
import { NoticeToasts } from "@/components/NoticeToasts";
import { ProfileMenu } from "@/components/ProfileMenu";
import { RangePicker } from "@/components/RangePicker";
import { Tour, tourSteps } from "@/components/Tour";
import { canOpen } from "@/lib/access";
import { apiEnabled } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import { useStore } from "@/lib/store";
import { homeFor, userKey } from "@/lib/user";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { hydrated, hasData, model, range, fileName, user } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [tourOpen, setTourOpen] = useState(false);
  const [toastsGo, setToastsGo] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (!hasData) router.replace("/");
    else if (!user) router.replace("/?step=role");
  }, [hydrated, hasData, user, router]);

  // Page-level access: outside your scope means back to your own home page.
  const [, , section, id] = pathname.split("/");
  const allowed = !user || !model || (canOpen(user, pathname) && (section !== "rep" || model.repById.has(id)));
  useEffect(() => {
    if (user && model && !allowed) router.replace(homeFor(user));
  }, [allowed, user, model, router]);

  // First visit for this person: start the tour once the page has rendered.
  const tourKey = user ? `dealerpulse:tour:${userKey(user)}` : null;
  useEffect(() => {
    if (!tourKey || !model) return;
    // Tour already seen: pop notifications once per browser session instead.
    if (localStorage.getItem(tourKey)) {
      const seen = sessionStorage.getItem(`${tourKey}:toasted`);
      if (seen) return;
      const t = setTimeout(() => { setToastsGo(true); sessionStorage.setItem(`${tourKey}:toasted`, "1"); }, 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setTourOpen(true), 600);
    return () => clearTimeout(t);
  }, [tourKey, model]);
  const endTour = useCallback(() => {
    setTourOpen(false);
    if (tourKey) {
      localStorage.setItem(tourKey, "done");
      sessionStorage.setItem(`${tourKey}:toasted`, "1");
    }
    setToastsGo(true);
  }, [tourKey]);

  const nav = useMemo(() => {
    if (!user) return [];
    const home = homeFor(user);
    const scopeQs = user.role === "rep" ? `?rep=${user.repId}` : user.role === "manager" ? `?branch=${user.branchId}` : "";
    const items: { href: string; label: string; short: string; icon: NavIconName }[] = [{ href: home, label: user.role === "ceo" ? "Overview" : user.role === "manager" ? "My branch" : "My sales", short: "Home", icon: "home" }];
    items.push({ href: `/dashboard/funnel${user.role === "manager" ? scopeQs : ""}`, label: "Sales funnel", short: "Funnel", icon: "funnel" });
    items.push({ href: `/dashboard/followups${scopeQs}`, label: "Follow-ups", short: "Calls", icon: "phone" });
    if (user.role !== "rep") items.push({ href: "/dashboard/anomalies", label: "Unusual patterns", short: "Unusual", icon: "alert" });
    if (apiEnabled && user.role === "ceo") items.push({ href: "/dashboard/admin", label: "Data and logins", short: "Admin", icon: "users" });
    return items;
  }, [user]);

  if (!hydrated || !model || !range || !user || !allowed) {
    return (
      <div className="container stack" aria-busy="true" aria-label="Loading your dashboard">
        <div className="skeleton" style={{ height: 56 }} />
        <div className="skeleton" style={{ height: 220 }} />
        <div className="grid grid-kpi">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      </div>
    );
  }

  const where = user.branchId ? model.branchById.get(user.branchId)?.name ?? "your branch" : "your network";

  return (
    <AnomalyProvider>
    <NoticeProvider>
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand href={homeFor(user)} />
          <nav className="nav" aria-label="Main" data-tour="nav">
            {nav.map((n) => {
              const path = n.href.split("?")[0];
              const active = pathname === path;
              return (
                <Link key={n.href} href={n.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined} title={n.label}>
                  <NavIcon name={n.icon} />
                  <span className="nav-label">{n.label}</span>
                  <span className="nav-short" aria-hidden="true">{n.short}</span>
                  {n.href === "/dashboard/anomalies" && <NavCount />}
                </Link>
              );
            })}
          </nav>
          <div className="topbar-spacer" />
          <div className="topbar-user">
            <NotificationBell />
            <ProfileMenu onReplayTour={() => setTourOpen(true)} />
          </div>
        </div>
        <div className="subbar">
          <div className="subbar-inner">
            <span className="subtle">Showing</span>
            <RangePicker />
          </div>
        </div>
      </header>
      <main id="main" className="container">
        {children}
        <p className="subtle footer-note">
          Figures are up to {dateLabel(new Date(model.asOf).toISOString())}, the latest date in {fileName ?? "your file"}.
        </p>
      </main>
      {tourOpen && <Tour steps={tourSteps(user, where)} onDone={endTour} />}
      <NoticeToasts start={toastsGo && !tourOpen} />
    </NoticeProvider>
    </AnomalyProvider>
  );
}
