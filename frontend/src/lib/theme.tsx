"use client";

import { createContext, ReactNode, useContext, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "dealerpulse:theme";

/** Runs before paint so the page never flashes the wrong theme. */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${KEY}')||'system';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){}})()`;

interface ThemeCtx {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  resolved: "light" | "dark";
}

const Ctx = createContext<ThemeCtx>({ pref: "system", setPref: () => {}, resolved: "light" });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(KEY) as ThemePref | null;
    if (saved === "light" || saved === "dark" || saved === "system") setPrefState(saved);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    localStorage.setItem(KEY, p);
  };

  return <Ctx.Provider value={{ pref, setPref, resolved }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** SVG attributes can't read CSS variables, so charts get concrete colours per theme. */
export function useChartColors() {
  const { resolved } = useTheme();
  return resolved === "dark"
    ? { data: "#6ea2d8", dataSoft: "#2b4763", go: "#33c38a", signal: "#f0444b", amber: "#f5b13a", grid: "#223142", axis: "#8b9aab", label: "#c3cfdb", cursor: "rgba(255,255,255,0.04)", ramp: ["#2b4763", "#3a5f86", "#4d7aa8", "#5f8fc2", "#6ea2d8", "#33c38a"] }
    : { data: "#2d5b8a", dataSoft: "#c9d8e8", go: "#13895a", signal: "#d8232a", amber: "#e59a0b", grid: "#e6eaef", axis: "#6b7a8a", label: "#3d4a58", cursor: "rgba(14,26,38,0.04)", ramp: ["#c9d8e8", "#a5bfd9", "#7ea2c6", "#5683b0", "#2d5b8a", "#13895a"] };
}
