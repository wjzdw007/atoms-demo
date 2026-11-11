import Link from "next/link";

/** The demo's own mark, drawn to sit comfortably next to the Atoms look without copying its logo. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#0c0c0c" />
      <path d="M5.2 14.6c2.2 3.4 7.6 4.4 11.400 1.200" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="16.4" cy="8.2" r="2.3" fill="#fff" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2 text-[17px] font-bold tracking-tight text-ink">
      <Logo />
      {!compact && (
        <span className="flex items-center gap-2">
          Atoms
          <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-muted">Demo</span>
        </span>
      )}
    </Link>
  );
}
