import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, ChevronDown, Info } from "lucide-react";
import { useStore } from "../lib/store";
import { send } from "../lib/transport";
import { EventBubble } from "../components/EventBubble";
import { ToolGroup } from "../components/ToolGroup";
import { groupEvents } from "../lib/groupEvents";
import { StatusIcon, statusLabel } from "../components/StatusIcon";
import { timeAgo } from "../lib/time";
import { SessionInfoModal } from "../components/SessionInfoModal";
import type { SessionEvent } from "../../shared/types";

// Stable empty array so the `?? EMPTY` fallback never produces a new reference
// on each getSnapshot call (which would cause useSyncExternalStore to loop).
const EMPTY_EVENTS: SessionEvent[] = [];

/** How many filtered events to show initially and per "load more" page. */
const PAGE = 80;

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const session = useStore((s) => (id ? s.sessions[id] : undefined));
  const rawEvents = useStore((s) => (id ? s.events[id] : undefined));
  const events = rawEvents ?? EMPTY_EVENTS;
  const token = useStore((s) => s.token);
  const [requested, setRequested] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  // How many filtered events to render (counted from the end — newest last).
  const [displayCount, setDisplayCount] = useState(PAGE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastLenRef = useRef(0);
  // Used to restore scroll position after prepending older events.
  const prevScrollHeightRef = useRef(0);
  const restoringScrollRef = useRef(false);

  // Reset window when switching to a different session.
  useEffect(() => {
    setDisplayCount(PAGE);
    setRequested(false);
  }, [id]);

  useEffect(() => {
    if (id && token && !requested) {
      send({ kind: "request_history", sessionId: id, limit: 150 });
      setRequested(true);
    }
  }, [id, token, requested]);

  // After "load more" expands the list, restore scroll position so the
  // previously-visible content stays in view (no jarring jump to top).
  useLayoutEffect(() => {
    if (restoringScrollRef.current && containerRef.current) {
      const el = containerRef.current;
      el.scrollTop = el.scrollTop + (el.scrollHeight - prevScrollHeightRef.current);
      restoringScrollRef.current = false;
    }
  });

  // Auto-scroll to bottom when new events arrive, if user hasn't scrolled up.
  useEffect(() => {
    if (events.length > lastLenRef.current && autoScroll && containerRef.current) {
      const el = containerRef.current;
      el.scrollTop = el.scrollHeight;
    }
    lastLenRef.current = events.length;
  }, [events.length, autoScroll]);

  // Detect user scroll to disable auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setAutoScroll(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      // Skip noisy queue ops / internal hook attachments unless they're errors.
      if (e.type === "system" && (e.text?.startsWith('{"operation"') || !e.text)) return false;
      if (e.type === "attachment" && (e.attachmentKind === "goal_status" || e.attachmentKind === "hook_success")) {
        return false;
      }
      return true;
    });
  }, [events]);

  if (!id) return null;
  if (!session) {
    return (
      <div className="flex flex-col flex-1 min-h-full">
        <header className="safe-top safe-x px-4 py-3 flex items-center gap-2 border-b" style={{ borderColor: "var(--border)" }}>
          <Link to="/" className="text-sm" style={{ color: "var(--accent)" }}>
            ← Sessions
          </Link>
        </header>
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          This session isn't loaded — it may have been removed.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-full" style={{ background: "var(--bg)" }}>
      <header
        className="sticky top-0 z-20 safe-top safe-x px-4 pt-3 pb-2"
        style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="flex items-center justify-center w-8 h-8 rounded-md"
            style={{ background: "var(--bg-subtle)", color: "var(--accent)" }}
          >
            <ChevronLeft size={18} />
          </Link>
          <StatusIcon status={session.status} size={18} />
          <div className="min-w-0 flex-1">
            {/* Project path — small, above the title */}
            <div className="text-[10px] truncate" style={{ color: "var(--text-faint)" }}>
              {session.projectLabel}
            </div>
            {/* AI/custom title — main headline */}
            <div className="text-sm font-medium truncate leading-tight" style={{ color: "var(--text)" }}>
              {session.customTitle ?? session.aiTitle ?? session.projectLabel}
            </div>
            <div
              className="text-xs truncate flex items-center gap-1.5 mt-0.5"
              style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}
            >
              <span>{statusLabel(session.status)}</span>
              {session.currentActivity && <span>· {session.currentActivity}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => setInfoOpen(true)}
              className="flex items-center justify-center w-7 h-7 rounded-md transition-colors"
              style={{ background: "var(--bg-subtle)", color: "var(--text-muted)" }}
              aria-label="Session details"
              title="Where is this transcript stored?"
            >
              <Info size={14} />
            </button>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>
              {timeAgo(session.lastEventAt)}
            </div>
          </div>
        </div>
        {session.gitBranch && (
          <div className="text-[10px] mt-1" style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
            {session.gitBranch} · {session.id.slice(0, 8)} · {session.eventCount} events
          </div>
        )}
      </header>

      {infoOpen && <SessionInfoModal sessionId={session.id} onClose={() => setInfoOpen(false)} />}

      <div ref={containerRef} className="flex-1 overflow-y-auto px-3 py-2 safe-bottom">
        {filtered.length === 0 ? (
          <div className="px-6 pt-16 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            Loading session history…
          </div>
        ) : (() => {
          const hidden = Math.max(0, filtered.length - displayCount);
          const visible = hidden > 0 ? filtered.slice(hidden) : filtered;
          const groups = groupEvents(visible);
          return (
            <>
              {hidden > 0 && (
                <div className="flex justify-center py-3">
                  <button
                    onClick={() => {
                      if (containerRef.current) {
                        prevScrollHeightRef.current = containerRef.current.scrollHeight;
                        restoringScrollRef.current = true;
                      }
                      setDisplayCount((c) => c + PAGE);
                    }}
                    className="text-xs px-4 py-1.5 rounded-full"
                    style={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    ↑ Load {Math.min(PAGE, hidden)} older messages ({hidden} hidden)
                  </button>
                </div>
              )}
              {groups.map((group, idx) => {
                if (group.kind === "tools") {
                  const key = group.pairs[0]?.use.toolUseId ?? `tools-${idx}`;
                  return <ToolGroup key={key} pairs={group.pairs} isLast={idx === groups.length - 1} />;
                }
                const e = group.event;
                return <EventBubble key={`${e.uuid ?? e.ts}-${idx}`} event={e} />;
              })}
            </>
          );
        })()}
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            const el = containerRef.current;
            if (el) {
              el.scrollTop = el.scrollHeight;
              setAutoScroll(true);
            }
          }}
          className="fixed bottom-6 right-6 flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium shadow"
          style={{
            background: "var(--accent)",
            color: "white",
            boxShadow: "var(--shadow)",
          }}
        >
          <ChevronDown size={14} /> jump to live
        </button>
      )}
    </div>
  );
}
