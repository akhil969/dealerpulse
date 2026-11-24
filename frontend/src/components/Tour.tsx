"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { User } from "@/lib/user";

export interface TourStep {
  /** Matches a data-tour attribute; omit for a centred message. */
  target?: string;
  title: string;
  body: string;
}

export function tourSteps(user: User, where: string): TourStep[] {
  const first = user.name.split(" ")[0];
  const intro = {
    ceo: `This is your whole dealer network on one screen: how every branch is selling, where deals slip away and what to fix first.`,
    manager: `This is ${where} on one screen: how your branch is tracking against target, how each person on your team is doing, and which customers need a call.`,
    rep: `This is your own sales desk: your enquiries, your orders and the customers you should follow up with today.`,
  }[user.role];
  return [
    { title: `Welcome, ${first}`, body: `${intro} This quick tour takes about a minute. You can leave it at any time with Esc.` },
    {
      target: "pulse",
      title: user.role === "rep" ? "How well your leads turn into sales" : "How close you are to target",
      body: user.role === "rep"
        ? "The dial shows the share of your enquiries that became orders. The sentence next to it compares you with your branch."
        : "The dial shows progress against target: red is well behind, amber is behind, green is on track. The sentence next to it explains the biggest reason.",
    },
    { target: "kpis", title: "Your key numbers", body: "These cards are the vital signs. Not sure what one means? Hover over or tap the small ? next to it for a plain explanation." },
    { target: "attention", title: "What needs attention", body: "DealerPulse checks your data for problems and lists them most urgent first. Press View on any item to see the customers behind it." },
    { target: "range", title: "Pick the months to look at", body: "Choose a period here. Every number and chart on every page updates to match." },
    { target: "nav", title: "Find your way around", body: "Home is your main view. Sales funnel shows where customers drop off between enquiry and delivery. Follow-ups is your call list for today. Unusual patterns lists numbers that look wrong, for you to confirm or dismiss." },
    { target: "bell", title: "Your notifications", body: "The bell collects things that need action from you, like a customer nobody has called for a week or a car that's late to be delivered." },
    { target: "profile", title: "Your profile", body: "Switch role, change between light and dark appearance, or bring this tour back whenever you like." },
  ];
}

const PAD = 8;
const POP_W = 340;

export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  // Skip steps whose target isn't on this page.
  const available = useMemo(
    () => steps.filter((s) => !s.target || document.querySelector(`[data-tour="${s.target}"]`)),
    [steps],
  );
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const step = available[i];
  const last = i === available.length - 1;

  useLayoutEffect(() => {
    if (!step?.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    const t = setTimeout(update, 400); // after smooth scroll settles
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  useEffect(() => {
    pop.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, available.length - 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, available.length, onDone]);

  if (!step) return null;

  let style: React.CSSProperties = { width: POP_W };
  if (rect) {
    const below = rect.bottom + PAD + 230 < window.innerHeight;
    const left = Math.min(Math.max(16, rect.left), window.innerWidth - POP_W - 16);
    style = below ? { ...style, top: rect.bottom + PAD + 12, left } : { ...style, top: Math.max(16, rect.top - PAD - 12), left, transform: "translateY(-100%)" };
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div className="tour-spot" style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div ref={pop} tabIndex={-1} className={`tour-pop${rect ? "" : " centered"}`} style={style}>
        <p className="eyebrow">Step {i + 1} of {available.length}</p>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {available.map((_, n) => <span key={n} className={n === i ? "on" : ""} />)}
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="link-btn" onClick={onDone}>Skip tour</button>
          <span className="row" style={{ gap: 8 }}>
            {i > 0 && <button className="btn btn-sm" onClick={() => setI(i - 1)}>Back</button>}
            <button className="btn btn-primary btn-sm" onClick={() => (last ? onDone() : setI(i + 1))}>
              {last ? "Start using DealerPulse" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
