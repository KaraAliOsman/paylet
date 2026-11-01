// Small inline SVG icons (24×24 grid, stroke = currentColor). Decorative unless a label is given.
import type { ReactNode } from "react";

function Svg({ label, size = 18, children, className }: { label?: string; size?: number; children: ReactNode; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { label?: string; size?: number; className?: string };

export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.2 4.2L19 7" />
  </Svg>
);
export const CrossIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const CommitIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 4L7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
  </Svg>
);
export const SnowIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 6.5l2.5-2M9.5 19.5L12 17.5l2.5 2" />
  </Svg>
);
export const BeaconIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
  </Svg>
);
export const DiceIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <circle cx="9" cy="9" r="0.9" fill="currentColor" />
    <circle cx="15" cy="15" r="0.9" fill="currentColor" />
    <circle cx="15" cy="9" r="0.9" fill="currentColor" />
    <circle cx="9" cy="15" r="0.9" fill="currentColor" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);
export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </Svg>
);
export const ArrowIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const SparkIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" />
  </Svg>
);
export const BotIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="8" width="15" height="11" rx="3" />
    <path d="M12 4.5V8M9 13h.01M15 13h.01" />
  </Svg>
);
export const UserIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
  </Svg>
);
