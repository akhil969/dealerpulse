"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDashboard } from "@/lib/store";

/** Branch filter stored in the URL (?branch=B1) so views can be shared and linked to. */
export function useBranchParam() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useDashboard();
  // Only leadership can pick a branch; everyone else is already scoped to their own data.
  const branch = user.role === "ceo" ? params.get("branch") ?? "" : "";
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { branch, params, set };
}

export function BranchSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { model } = useDashboard();
  return (
    <select aria-label="Branch" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All branches</option>
      {model.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}
