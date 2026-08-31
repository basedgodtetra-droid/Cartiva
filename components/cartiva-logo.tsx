import type { SVGProps } from "react";

interface CartivaLogoProps {
  compact?: boolean;
  className?: string;
  markClassName?: string;
}

export function CartivaMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Cartiva"
      className={className}
      {...props}
    >
      <rect width="64" height="64" rx="18" fill="currentColor" />
      <circle cx="17" cy="15" r="4.6" fill="#f5fff9" />
      <path
        d="M17 22l4 12-5 13M21 34l9 10M19 27l15 3M33 24h5l4 16h12l4-12H40M41 40h14"
        fill="none"
        stroke="#f5fff9"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="43" cy="48" r="2.8" fill="#f5fff9" />
      <circle cx="53" cy="48" r="2.8" fill="#f5fff9" />
    </svg>
  );
}

export function CartivaLogo({ compact = false, className, markClassName }: CartivaLogoProps) {
  return (
    <span className={className} aria-label="Cartiva">
      <CartivaMark className={markClassName} aria-hidden="true" />
      {!compact ? <span>Cartiva</span> : null}
    </span>
  );
}
