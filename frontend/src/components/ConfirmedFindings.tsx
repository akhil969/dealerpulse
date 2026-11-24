"use client";

import Link from "next/link";
import { useAnomalies } from "@/lib/anomaly/store";
import { Card } from "./ui";

/** Shows only anomalies a reviewer has confirmed. Renders nothing otherwise. */
export function ConfirmedFindings({ branchId, repId }: { branchId?: string; repId?: string }) {
  const { confirmedFor, reviews } = useAnomalies();
  const items = confirmedFor({ branchId, repId });
  if (!items.length) return null;
  return (
    <Card title="Confirmed problems" subtitle="Unusual patterns a reviewer has checked and confirmed"
      actions={<Link href="/dashboard/anomalies?tab=confirmed" className="btn btn-sm">See all</Link>}>
      <div className="insights">
        {items.map((a) => (
          <div key={a.id} className="insight sev-critical">
            <span className="insight-rail" />
            <div>
              <h3>{a.title}</h3>
              <p>{a.summary}</p>
              <p className="action">Confirmed by {reviews[a.id]?.by}{reviews[a.id]?.note ? `: “${reviews[a.id].note}”` : ""}</p>
            </div>
            {a.href && <Link href={a.href} className="btn btn-sm no-print">View</Link>}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Small marker next to a branch or person who has confirmed problems. */
export function ConfirmedBadge({ branchId, repId }: { branchId?: string; repId?: string }) {
  const { confirmedFor } = useAnomalies();
  const n = confirmedFor({ branchId, repId }).length;
  return n ? <span className="badge badge-bad" title="Confirmed unusual patterns">⚑ {n}</span> : null;
}
