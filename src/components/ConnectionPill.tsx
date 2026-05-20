interface Props {
  status: "disconnected" | "connecting" | "connected" | "unauthorized" | "error";
  hostname?: string;
}

const META: Record<Props["status"], { color: string; label: string }> = {
  connected:    { color: "var(--status-running)", label: "live" },
  connecting:   { color: "var(--status-tool)",    label: "…" },
  disconnected: { color: "var(--text-faint)",     label: "offline" },
  unauthorized: { color: "var(--status-error)",   label: "auth" },
  error:        { color: "var(--status-error)",   label: "error" },
};

/**
 * Compact connection indicator: a single colored dot plus a tiny status word.
 * Hostname is intentionally NOT shown here — it lives in Settings, so the
 * header stays uncluttered.
 */
export function ConnectionPill({ status }: Props) {
  const meta = META[status];
  const pulse = status === "connecting" || status === "connected";
  return (
    <div
      className="text-[10px] px-2 py-1 rounded-full flex items-center gap-1.5 uppercase tracking-wider"
      style={{
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        color: "var(--text-faint)",
      }}
      title={`Connection: ${meta.label}`}
    >
      <span
        className={pulse ? "pulse-dot" : ""}
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: meta.color,
          display: "inline-block",
        }}
      />
      <span>{meta.label}</span>
    </div>
  );
}
