import type { SessionSource } from "../../shared/types";

interface Props {
  source: SessionSource;
  size?: number;
  className?: string;
}

/**
 * Per-source brand-evoking icons. Simplified SVGs — not the actual brand
 * logos (we use neutral geometric shapes that suggest each tool without
 * appropriating their trademarks).
 *
 *   claude-code  → a starburst (Claude's signature visual cue)
 *   cowork       → same starburst but with a connector loop (collaboration)
 *   cursor       → an I-beam / mouse pointer arrow
 */
export function ProviderIcon({ source, size = 14, className }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true as const,
    className,
  };

  if (source === "cursor") {
    // Stylized arrow cursor.
    return (
      <svg {...common}>
        <path d="M5 3.5 L19.5 11.5 L13 12.5 L17 19.5 L14 21 L10.5 14 L5 19 Z" />
      </svg>
    );
  }

  if (source === "cowork") {
    // Claude burst + a small linking arc to suggest collaboration.
    return (
      <svg {...common}>
        <path d="M12 3 L13 9 L19 8 L14.5 12 L19 16 L13 15 L12 21 L11 15 L5 16 L9.5 12 L5 8 L11 9 Z" opacity="0.85" />
        <path d="M16 16 a3 3 0 1 0 0 -4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  // Default: claude-code — the Claude burst.
  return (
    <svg {...common}>
      <path d="M12 2.5 L13.2 9.2 L19.8 8.3 L14.7 12 L19.8 15.7 L13.2 14.8 L12 21.5 L10.8 14.8 L4.2 15.7 L9.3 12 L4.2 8.3 L10.8 9.2 Z" />
    </svg>
  );
}

/** Color tokens used alongside the icon — kept in sync with SOURCE_STYLE. */
export const SOURCE_COLOR: Record<SessionSource, string> = {
  "claude-code": "var(--accent)",
  cowork: "#a89df7",
  cursor: "#5fb9ff",
};
