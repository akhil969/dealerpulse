/**
 * Client for the DealerPulse Flask API (API/README.md).
 * API mode is on when NEXT_PUBLIC_API_URL is set; otherwise the app runs browser-only with local files.
 */
import type { Anomaly } from "./anomaly/detect";
import type { Notice } from "./notifications";
import type { DealershipData } from "./types";
import type { ValidationIssue } from "./validate";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const apiEnabled = API_URL !== "";

const TOKEN_KEY = "dealerpulse:token";
export const SIGNED_OUT_EVENT = "dealerpulse:signed-out";

/** The access token lives in sessionStorage: gone when the tab closes, never in a cookie or URL. */
export const session = {
  get: () => (typeof window === "undefined" ? null : sessionStorage.getItem(TOKEN_KEY)),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const token = session.get();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Can't reach the DealerPulse server. Check that it's running and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) {
      session.clear();
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    const err = body?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  return body as T;
}

export interface ApiUser {
  id: number;
  username: string;
  display_name: string;
  role: "ceo" | "manager" | "rep";
  rep_id: string | null;
  branch_id: string | null;
}

export interface Paged<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
  has_next: boolean;
}

export interface LoginRow extends ApiUser {
  active: boolean;
  locked: boolean;
  created_at: string;
  created_by: string | null;
  last_login_at: string | null;
}

export interface Candidate {
  id: string;
  name: string;
  branch_id: string;
  role: "branch_manager" | "sales_officer";
  branch_name: string;
  login_role: "manager" | "rep";
}

export interface DatasetInfo {
  loaded: boolean;
  version?: string;
  uploaded_at?: string;
  as_of?: number;
  months?: string[];
  uploaded_by?: string;
  source_name?: string;
  counts?: Record<string, number>;
}

export interface UploadProblems {
  ok: false;
  error_count: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ServerAnomaly extends Anomaly {
  status: "flagged" | "confirmed" | "dismissed";
  review: { decision: "confirmed" | "dismissed"; note: string; by: string; role: string; at: string } | null;
  can_review: boolean;
}

const qs = (p: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && s.set(k, String(v)));
  const out = s.toString();
  return out ? `?${out}` : "";
};

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; expires_in: number; user: ApiUser }>("/api/auth/login", { method: "POST", json: { username, password } }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<ApiUser>("/api/auth/me"),
  refresh: () => request<{ access_token: string; expires_in: number }>("/api/auth/refresh", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) =>
    request<void>("/api/auth/password", { method: "POST", json: { current_password, new_password } }),

  datasetInfo: () => request<DatasetInfo>("/api/dataset/info"),
  /** Already scoped to the signed-in person by the server. */
  getDataset: () => request<DealershipData>("/api/dataset"),
  upload: (data: unknown, fileName: string) =>
    request<{ version: string; counts: Record<string, number>; warnings: ValidationIssue[]; unlinked_logins: string[] }>("/api/dataset", {
      method: "POST", json: data, headers: { "X-File-Name": fileName.slice(0, 200) },
    }),

  users: (p: { page?: number; page_size?: number; q?: string; role?: string }) => request<Paged<LoginRow>>(`/api/users${qs(p)}`),
  candidates: (p: { page?: number; page_size?: number; q?: string; branch_id?: string }) =>
    request<Paged<Candidate>>(`/api/users/candidates${qs(p)}`),
  createUser: (body: Record<string, unknown>) => request<LoginRow>("/api/users", { method: "POST", json: body }),
  updateUser: (id: number, body: Record<string, unknown>) => request<LoginRow>(`/api/users/${id}`, { method: "PATCH", json: body }),
  deleteUser: (id: number) => request<void>(`/api/users/${id}`, { method: "DELETE" }),
  branches: () => request<Paged<{ id: string; name: string; city: string }>>("/api/branches?page_size=200"),

  notifications: () => request<Paged<Notice & { read: boolean }> & { unread: number }>("/api/notifications?page_size=200"),
  markRead: (ids: string[]) => request<{ marked: number }>("/api/notifications/read", { method: "POST", json: { ids } }),
  streamTicket: () => request<{ ticket: string; expires_in: number }>("/api/notifications/stream-ticket", { method: "POST" }),
  streamUrl: (ticket: string) => `${API_URL}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`,

  anomalies: () => request<Paged<ServerAnomaly> & { counts: Record<string, number> }>("/api/anomalies?page_size=200"),
  review: (id: string, decision: "confirmed" | "dismissed", note: string) =>
    request<ServerAnomaly>(`/api/anomalies/${encodeURIComponent(id)}/review`, { method: "PUT", json: { decision, note } }),
  reopen: (id: string, note = "") =>
    request<ServerAnomaly>(`/api/anomalies/${encodeURIComponent(id)}/review`, { method: "DELETE", json: { note } }),
};
