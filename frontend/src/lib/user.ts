import type { Model } from "./analytics";

export type Role = "ceo" | "manager" | "rep";

export interface User {
  role: Role;
  name: string;
  /** Sales rep id for managers and reps (managers are reps with role branch_manager). */
  repId?: string;
  branchId?: string;
}

export const ROLE_LABEL: Record<Role, string> = {
  ceo: "Leadership",
  manager: "Branch manager",
  rep: "Sales rep",
};

/** Stable key for per-user storage (tour progress, read notifications). */
export const userKey = (u: User) => u.repId ?? u.role;

export function homeFor(u: User): string {
  if (u.role === "manager" && u.branchId) return `/dashboard/branch/${u.branchId}`;
  if (u.role === "rep" && u.repId) return `/dashboard/rep/${u.repId}`;
  return "/dashboard";
}

/** A saved user only makes sense if the person still exists in the loaded data. */
export function isValidFor(u: User, m: Model): boolean {
  if (u.role === "ceo") return true;
  const rep = u.repId ? m.repById.get(u.repId) : undefined;
  return !!rep && rep.branch_id === u.branchId;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}
