import {
  Circle,
  Wrench,
  MessageSquare,
  Minus,
  AlertCircle,
  RotateCcw,
} from "lucide-react";
import type { SessionStatus } from "../../shared/types";

interface Props {
  status: SessionStatus;
  size?: number;
}

type StatusMeta = {
  color: string;
  label: string;
  pulse: boolean;
  /** Render as a quiet dot instead of a filled icon (used for idle/compacted). */
  quiet: boolean;
  Icon: typeof Circle;
};

const META: Record<SessionStatus, StatusMeta> = {
  running:        { color: "var(--status-running)", label: "Running",             pulse: true,  quiet: false, Icon: Circle },
  "running-tool": { color: "var(--status-tool)",    label: "Tool running",        pulse: true,  quiet: false, Icon: Wrench },
  "awaiting-user":{ color: "var(--status-waiting)", label: "Awaiting your reply", pulse: false, quiet: false, Icon: MessageSquare },
  idle:           { color: "var(--status-idle)",    label: "Idle",                pulse: false, quiet: true,  Icon: Minus },
  errored:        { color: "var(--status-error)",   label: "Error",               pulse: false, quiet: false, Icon: AlertCircle },
  compacted:      { color: "var(--text-faint)",     label: "Compacted",           pulse: false, quiet: true,  Icon: RotateCcw },
};

export function StatusIcon({ status, size = 22 }: Props) {
  const meta = META[status];
  // Quiet states (idle, compacted) render as a small filled dot instead of a
  // big icon-in-circle. Active states get the full treatment so they stand out.
  if (meta.quiet) {
    return (
      <span
        title={meta.label}
        aria-label={meta.label}
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: meta.color,
          flexShrink: 0,
          margin: `${(size - 8) / 2}px`, // center within the 22px slot
          opacity: 0.55,
        }}
      />
    );
  }
  const { Icon } = meta;
  const iconSize = Math.round(size * 0.58);
  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      className={meta.pulse ? "pulse-dot" : ""}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: meta.color,
        color: "#fff",
        flexShrink: 0,
        boxShadow: meta.pulse ? `0 0 0 4px ${meta.color}22` : undefined,
      }}
    >
      <Icon size={iconSize} strokeWidth={2.5} />
    </span>
  );
}

export function statusLabel(status: SessionStatus): string {
  return META[status].label;
}
