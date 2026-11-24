"use client";

import { useAnomalies } from "@/lib/anomaly/store";

/** Number of unusual patterns waiting for this person's review. */
export function NavCount() {
  const { pendingCount } = useAnomalies();
  return pendingCount ? <span className="nav-count" aria-label={`${pendingCount} to review`}>{pendingCount}</span> : null;
}
