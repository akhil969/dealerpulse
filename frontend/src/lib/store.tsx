"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { scopeData } from "./access";
import { api, apiEnabled, ApiUser, DatasetInfo, session, SIGNED_OUT_EVENT } from "./api";
import { buildModel, Model, Range } from "./analytics";
import { Branch, DealershipData, SalesRep } from "./types";
import { isValidFor, User } from "./user";
import { validateDealershipData } from "./validate";

const DATA_KEY = "dealerpulse:data";
const NAME_KEY = "dealerpulse:filename";
const USER_KEY = "dealerpulse:user";

/** What the sign-in step may know about a file: who works where, and how big it is. No leads, targets or deliveries. */
export interface Roster {
  branches: Branch[];
  reps: Pick<SalesRep, "id" | "name" | "branch_id" | "role">[];
  counts: { leads: number; months: number };
}

interface Store {
  /** True once we've checked storage for previously loaded data. */
  hydrated: boolean;
  hasData: boolean;
  roster: Roster | null;
  /** Identifies the uploaded file, the same for every role (reviews and read state are keyed on it). */
  datasetId: string | null;
  /** The signed-in person's view of the data: rows and fields filtered by lib/access.ts. Null until someone signs in. */
  model: Model | null;
  fileName: string | null;
  range: Range | null;
  setRange: (r: Range) => void;
  user: User | null;
  setUser: (u: User | null) => void;
  load: (data: DealershipData, fileName: string) => void;
  clear: () => void;
  /** API mode: data, sign-in and uploads go through the Flask API (NEXT_PUBLIC_API_URL). */
  apiMode: boolean;
  datasetInfo: DatasetInfo | null;
  signIn: (username: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  /** Re-fetch the signed-in person's data, e.g. after an upload. */
  reloadFromApi: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

function fingerprint(s: string): string {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function userFromApi(u: ApiUser): User {
  return { role: u.role, name: u.display_name, repId: u.rep_id ?? undefined, branchId: u.branch_id ?? undefined };
}

function readUser(full: Model): User | null {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) ?? "null") as User | null;
    return u && isValidFor(u, full) ? u : null;
  } catch {
    return null;
  }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  // The unscoped file. Private to this provider, never handed to pages.
  const [raw, setRaw] = useState<DealershipData | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [user, setUserState] = useState<User | null>(null);

  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);
  const full = useMemo(() => (raw ? buildModel(raw) : null), [raw]);

  /** API mode: fetch who I am and my (already scoped) data. */
  const fetchFromApi = useCallback(async () => {
    const [me, info, data] = await Promise.all([api.me(), api.datasetInfo(), api.getDataset()]);
    setDatasetInfo(info);
    setRaw(data);
    setFileName(info.source_name ?? "Company server");
    const months = info.months?.length ? info.months : buildModel(data).months;
    setRange({ from: months[0], to: months[months.length - 1] });
    const u = userFromApi(me);
    setUserState(u);
    return u;
  }, []);

  const resetState = useCallback(() => {
    setRaw(null);
    setRange(null);
    setFileName(null);
    setUserState(null);
    setDatasetInfo(null);
  }, []);

  useEffect(() => {
    if (!apiEnabled) return;
    const onSignedOut = () => resetState();
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [resetState]);

  // Keep the session alive while the tab is open (tokens last 30 minutes).
  useEffect(() => {
    if (!apiEnabled || !user) return;
    const t = setInterval(() => api.refresh().then((r) => session.set(r.access_token)).catch(() => {}), 20 * 60_000);
    return () => clearInterval(t);
  }, [user]);

  const signIn = useCallback(async (username: string, password: string) => {
    const r = await api.login(username, password);
    session.set(r.access_token);
    return fetchFromApi();
  }, [fetchFromApi]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {}); // revokes the token on the server
    session.clear();
    resetState();
  }, [resetState]);

  const reloadFromApi = useCallback(async () => {
    await fetchFromApi();
  }, [fetchFromApi]);

  useEffect(() => {
    if (apiEnabled) {
      if (session.get()) fetchFromApi().catch(() => session.clear()).finally(() => setHydrated(true));
      else setHydrated(true);
      return;
    }
    try {
      const saved = sessionStorage.getItem(DATA_KEY);
      if (saved) {
        const result = validateDealershipData(JSON.parse(saved));
        if (result.ok && result.data) {
          const m = buildModel(result.data);
          setRaw(result.data);
          setRange({ from: m.months[0], to: m.months[m.months.length - 1] });
          setFileName(sessionStorage.getItem(NAME_KEY));
          setUserState(readUser(m));
        }
      }
    } catch {
      sessionStorage.removeItem(DATA_KEY);
    }
    setHydrated(true);
  }, []);

  const load = useCallback((data: DealershipData, name: string) => {
    const m = buildModel(data);
    setRaw(data);
    setRange({ from: m.months[0], to: m.months[m.months.length - 1] });
    setFileName(name);
    setUserState(readUser(m));
    try {
      sessionStorage.setItem(DATA_KEY, JSON.stringify(data));
      sessionStorage.setItem(NAME_KEY, name);
    } catch {
      // shortcut: quota exceeded means data lives only in this tab; move to IndexedDB or the API if files get large.
    }
  }, []);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  }, []);

  const clear = useCallback(() => {
    setRaw(null);
    setRange(null);
    setFileName(null);
    sessionStorage.removeItem(DATA_KEY);
    sessionStorage.removeItem(NAME_KEY);
  }, []);

  // Scoped view: rebuilt whenever the file or the signed-in person changes. In API mode the server has already
  // scoped the data; applying the same policy again is a no-op and a second line of defence.
  const model = useMemo(() => {
    if (!raw || !full || !user) return null;
    const basis = apiEnabled && datasetInfo?.as_of && datasetInfo.months?.length
      ? { asOf: datasetInfo.as_of, months: datasetInfo.months }
      : { asOf: full.asOf, months: full.months };
    return buildModel(scopeData(raw, user), basis);
  }, [raw, full, user, datasetInfo]);

  const roster = useMemo<Roster | null>(() => full && {
    branches: full.branches,
    reps: full.reps.map(({ id, name, branch_id, role }) => ({ id, name, branch_id, role })),
    counts: { leads: full.leads.length, months: full.months.length },
  }, [full]);

  const datasetId = useMemo(
    () => (apiEnabled ? datasetInfo?.version ?? null : full ? fingerprint(`${fileName}|${full.asOf}|${full.leads.length}`) : null),
    [full, fileName, datasetInfo],
  );

  const value = useMemo(
    () => ({ hydrated, hasData: !!raw, roster, datasetId, model, fileName, range, setRange, user, setUser, load, clear,
      apiMode: apiEnabled, datasetInfo, signIn, signOut, reloadFromApi }),
    [hydrated, raw, roster, datasetId, model, fileName, range, user, setUser, load, clear, datasetInfo, signIn, signOut, reloadFromApi],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside DataProvider");
  return ctx;
}

/** For dashboard pages: data, range and user are guaranteed by the dashboard layout. */
export function useDashboard() {
  const { model, range, user } = useStore();
  if (!model || !range || !user) throw new Error("Dashboard rendered without data");
  return { model, range, user };
}
