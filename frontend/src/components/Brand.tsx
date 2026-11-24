"use client";

import Link from "next/link";
import { useState } from "react";
import { useStore } from "@/lib/store";

/**
 * Header lockup: DealerPulse + the manufacturer brand detected from the data.
 * Drop the official logo at public/brand/<brand>.svg (e.g. toyota.svg); until then a text label is shown.
 */
export function Brand({ href = "/" }: { href?: string }) {
  const { roster } = useStore();
  const [logoFailed, setLogoFailed] = useState(false);
  const names = roster?.branches.map((b) => b.name) ?? [];
  const brand = names.length && names.every((n) => /toyota/i.test(n)) ? "toyota" : null;

  return (
    <Link href={href} className="brand" aria-label="DealerPulse home">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 13h4l2.5-6 4 11 3-8 1.5 3H22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="brand-name">DealerPulse</span>
      {brand && (
        <>
          <span className="brand-sep" aria-hidden="true" />
          {logoFailed ? (
            <span className="brand-oem">{brand.toUpperCase()}</span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="brand-logo" src={`/brand/${brand}.svg`} alt={brand} onError={() => setLogoFailed(true)} />
          )}
        </>
      )}
    </Link>
  );
}
