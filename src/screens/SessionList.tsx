import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { useStore, sortSessions } from "../lib/store";
import { SessionRow } from "../components/SessionRow";
import { ConnectionPill } from "../components/ConnectionPill";
import { ProviderIcon } from "../components/ProviderIcon";
import type { Session, SessionSource } from "../../shared/types";

/** UI source-filter tabs. "chat" is shown disabled — Claude.ai chats are cloud-only. */
type SourceFilter = "all" | "claude-code" | "cowork" | "cursor" | "chat";

interface Tab {
  id: SourceFilter;
  label: string;
  /** Source whose icon should appear in the tab (omit for All / Chat). */
  iconSource?: SessionSource;
  /** When true, the tab is rendered but not clickable. */
  disabled?: boolean;
  /** Predicate to determine if a session belongs to this tab. */
  matches: (s: Session) => boolean;
}

const TABS: Tab[] = [
  { id: "all",         label: "All",    matches: () => true },
  { id: "claude-code", label: "Claude", iconSource: "claude-code", matches: (s) => s.source === "claude-code" },
  { id: "cowork",      label: "Cowork", iconSource: "cowork",      matches: (s) => s.source === "cowork" },
  { id: "cursor",      label: "Cursor", iconSource: "cursor",      matches: (s) => s.source === "cursor" },
  // Disabled placeholder — Chat lives on Anthropic's servers, no local files to tail.
  { id: "chat",        label: "Chat",   disabled: true, matches: () => false },
];

export function SessionList() {
  const sessionsMap = useStore((s) => s.sessions);
  const connection = useStore((s) => s.connection);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");

  // Tab strip scroll-fade affordance — true on each side means "there's more
  // content that direction, show the fade gradient".
  const tabRowRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const updateTabScroll = useCallback(() => {
    const el = tabRowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setTabScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useLayoutEffect(() => {
    updateTabScroll();
    window.addEventListener("resize", updateTabScroll);
    return () => window.removeEventListener("resize", updateTabScroll);
  }, [updateTabScroll]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const sessions = useMemo(() => sortSessions(sessionsMap), [sessionsMap, now]);
  // Per-tab counts for the pill badges — computed once.
  const counts = useMemo(() => {
    const c = { all: 0, "claude-code": 0, cowork: 0, cursor: 0 } as Record<SourceFilter, number>;
    for (const s of sessions) {
      if (s.status === "compacted") continue;
      c.all += 1;
      const key = s.source as keyof typeof c;
      if (key in c) c[key] += 1;
    }
    return c;
  }, [sessions]);

  const filtered = useMemo(() => {
    const tab = TABS.find((t) => t.id === filter) ?? TABS[0];
    // Always hide compacted (archived) sessions; otherwise apply tab + search.
    let list = sessions.filter((s) => s.status !== "compacted" && tab.matches(s));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (s) =>
          s.projectLabel.toLowerCase().includes(q) ||
          (s.aiTitle ?? "").toLowerCase().includes(q) ||
          (s.customTitle ?? "").toLowerCase().includes(q) ||
          (s.lastUserMessagePreview ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter, query]);

  return (
    <div className="flex flex-col flex-1 min-h-full">
      <header
        className="sticky top-0 z-20 safe-top safe-x px-4 pt-3 pb-2.5"
        style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}
      >
        {/* Row 1: title + connection + settings */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-base font-semibold tracking-tight" style={{ color: "var(--text)" }}>
              Sessions
            </h1>
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}
            >
              {filtered.length}
              {filtered.length !== counts.all && (
                <span style={{ opacity: 0.6 }}> · {counts.all}</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionPill status={connection.status} />
            <Link
              to="/settings"
              className="flex items-center justify-center w-8 h-8 rounded-md transition-colors hover:opacity-80"
              style={{ background: "var(--bg-subtle)", color: "var(--text-muted)" }}
              aria-label="Settings"
            >
              <Settings size={15} />
            </Link>
          </div>
        </div>

        {/* Row 2: search box */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sessions…"
          className="w-full px-3 py-1.5 rounded-md text-sm mb-2 focus:outline-none focus:border-accent"
          style={{
            background: "var(--bg-elevated)",
            color: "var(--text)",
            border: "1px solid var(--border)",
          }}
        />

        {/* Row 3: source tabs with edge scroll fades */}
        <div className="relative -mx-1">
          <div
            ref={tabRowRef}
            onScroll={updateTabScroll}
            className="flex items-center gap-1.5 overflow-x-auto no-scrollbar px-1 pb-0.5"
          >
            {TABS.map((tab) => {
              const active = filter === tab.id;
              const count = tab.id === "chat" ? null : counts[tab.id] ?? 0;
              return (
                <button
                  key={tab.id}
                  onClick={() => !tab.disabled && setFilter(tab.id)}
                  disabled={tab.disabled}
                  title={tab.disabled ? "Claude.ai chats live in the cloud — coming soon" : undefined}
                  className="text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 flex-shrink-0 font-medium transition-colors"
                  style={{
                    background: active ? "var(--accent)" : "var(--bg-subtle)",
                    color: active
                      ? "white"
                      : tab.disabled
                        ? "var(--text-faint)"
                        : "var(--text-muted)",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    opacity: tab.disabled ? 0.45 : 1,
                    cursor: tab.disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {tab.iconSource && (
                    <ProviderIcon source={tab.iconSource} size={11} />
                  )}
                  <span>{tab.label}</span>
                  {count !== null && count > 0 && (
                    <span
                      className="text-[10px] px-1.5 rounded-full tabular-nums leading-none py-px"
                      style={{
                        background: active ? "rgba(255,255,255,0.22)" : "var(--bg)",
                        color: active ? "white" : "var(--text-faint)",
                        minWidth: "18px",
                        textAlign: "center",
                      }}
                    >
                      {count}
                    </span>
                  )}
                  {tab.disabled && (
                    <span
                      className="text-[8px] uppercase tracking-wider font-semibold px-1 rounded"
                      style={{ background: "var(--bg)", color: "var(--text-faint)" }}
                    >
                      soon
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {/* Edge fades — symmetric scroll affordance; opacity reflects scroll state */}
          <div
            aria-hidden="true"
            className="absolute left-0 top-0 bottom-0 w-5 pointer-events-none transition-opacity"
            style={{
              background: "linear-gradient(to left, transparent, var(--bg) 70%)",
              opacity: tabScroll.left ? 1 : 0,
            }}
          />
          <div
            aria-hidden="true"
            className="absolute right-0 top-0 bottom-0 w-5 pointer-events-none transition-opacity"
            style={{
              background: "linear-gradient(to right, transparent, var(--bg) 70%)",
              opacity: tabScroll.right ? 1 : 0,
            }}
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto safe-bottom" style={{ background: "var(--bg)" }}>
        {filtered.length === 0 ? (
          <EmptyState filter={filter} totalCount={counts.all} onShowAll={() => setFilter("all")} />
        ) : (
          <ul>
            {filtered.map((s) => (
              <li key={s.id}>
                <SessionRow session={s} now={now} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  filter,
  totalCount,
  onShowAll,
}: {
  filter: SourceFilter;
  totalCount: number;
  onShowAll: () => void;
}) {
  if (totalCount === 0) {
    return (
      <div className="px-6 pt-16 text-center">
        <div className="text-4xl mb-2">·</div>
        <h2 className="text-base font-medium mb-1" style={{ color: "var(--text)" }}>
          Nothing yet
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Start a Claude Code (or Cursor) session on your desktop — it'll appear here in real time.
        </p>
      </div>
    );
  }
  const label = TABS.find((t) => t.id === filter)?.label ?? "this view";
  return (
    <div className="px-6 pt-16 text-center">
      <h2 className="text-base font-medium mb-1" style={{ color: "var(--text)" }}>
        Nothing in {label}
      </h2>
      <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
        {filter === "cursor"
          ? "No Cursor sessions found — open Cursor and chat there to see sessions here."
          : `Try the All tab — ${totalCount} session${totalCount === 1 ? "" : "s"} across other sources.`}
      </p>
      {filter !== "all" && (
        <button
          onClick={onShowAll}
          className="text-sm px-3 py-2 rounded-md"
          style={{ background: "var(--accent)", color: "white" }}
        >
          Show all
        </button>
      )}
    </div>
  );
}
