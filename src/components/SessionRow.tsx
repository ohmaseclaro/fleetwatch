import { Link } from "react-router-dom";
import type { Session, SessionSource, SessionStatus } from "../../shared/types";
import { StatusIcon } from "./StatusIcon";
import { ProviderIcon } from "./ProviderIcon";
import { timeAgo } from "../lib/time";

interface Props {
  session: Session;
  now: number;
}

/**
 * Per-source visual styling (color + background tint). Labels are no longer
 * shown on the row — the icon carries the identity, and the tab row spells
 * out the full name. Sub-label distinguishes Code vs Cowork within Claude.
 */
const SOURCE_STYLE: Record<SessionSource, { sub: string | null; color: string; bg: string }> = {
  "claude-code": { sub: null,       color: "var(--accent)", bg: "rgba(217, 119, 87, 0.14)" },
  cowork:        { sub: "cowork",   color: "#a89df7",       bg: "rgba(155, 135, 245, 0.14)" },
  cursor:        { sub: null,       color: "#5fb9ff",       bg: "rgba(77, 171, 247, 0.14)" },
};

/**
 * Map status → left edge stripe color. Idle/compacted return transparent
 * (no stripe) so quiet sessions stay quiet visually.
 */
function stripeFor(status: SessionStatus): string {
  switch (status) {
    case "running":
    case "running-tool":  return "var(--status-running)";
    case "awaiting-user": return "var(--status-waiting)";
    case "errored":       return "var(--status-error)";
    case "idle":
    case "compacted":     return "transparent";
  }
}

export function SessionRow({ session, now }: Props) {
  const title = session.customTitle ?? session.aiTitle;
  const subtitle = session.lastUserMessagePreview || session.gitBranch || "";
  const activity = session.currentActivity || "";
  const sourceStyle = SOURCE_STYLE[session.source] ?? SOURCE_STYLE["claude-code"];
  const stripeColor = stripeFor(session.status);
  return (
    <Link
      to={`/s/${session.id}`}
      className="block pl-3 pr-4 py-3 border-b active:bg-bg-subtle transition-colors"
      style={{
        borderBottomColor: "var(--border)",
        // 3px colored stripe on the left to mark active sessions at a glance.
        boxShadow: `inset 3px 0 0 ${stripeColor}`,
      }}
    >
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <StatusIcon status={session.status} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          {/* Row 1: provider icon + project / time */}
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="flex-shrink-0 inline-flex items-center justify-center rounded"
                style={{
                  color: sourceStyle.color,
                  background: sourceStyle.bg,
                  width: "20px",
                  height: "20px",
                }}
                aria-label={session.source}
                title={session.source}
              >
                <ProviderIcon source={session.source} size={12} />
              </span>
              <div className="text-xs truncate min-w-0" style={{ color: "var(--text-faint)" }}>
                {session.projectLabel.replace(/\s*\/\s*/g, " · ")}
                {sourceStyle.sub && (
                  <span
                    className="ml-1.5 text-[10px] uppercase tracking-wider"
                    style={{ color: sourceStyle.color }}
                  >
                    · {sourceStyle.sub}
                  </span>
                )}
                {session.isSubagent && (
                  <span className="ml-1.5" style={{ color: "var(--accent)" }}>· subagent</span>
                )}
              </div>
            </div>
            <div
              className="text-[11px] flex-shrink-0 tabular-nums"
              style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}
            >
              {timeAgo(session.lastUserMessageAt || session.lastEventAt, now)}
            </div>
          </div>
          {/* Row 2: AI-generated or custom title (or fallback to preview) */}
          <div
            className="text-sm font-medium mt-1 truncate leading-tight"
            style={{ color: "var(--text)" }}
          >
            {title || subtitle || (
              <span style={{ color: "var(--text-faint)", fontStyle: "italic" }}>
                no title yet
              </span>
            )}
          </div>
          {/* Row 3: last user message preview when distinct from the title */}
          {title && subtitle && (
            <div className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
              {subtitle}
            </div>
          )}
          {activity && (
            <div
              className="text-[11px] mt-1 truncate inline-flex items-center gap-1"
              style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
            >
              <span
                className="inline-block w-1 h-1 rounded-full"
                style={{ background: stripeColor !== "transparent" ? stripeColor : "var(--text-faint)" }}
              />
              {activity}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
