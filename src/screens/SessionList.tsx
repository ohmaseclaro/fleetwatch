import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Settings } from "lucide-react";
import { useStore, sortSessions, sessionSortKey } from "../lib/store";
import { SessionRow } from "../components/SessionRow";
import { ConnectionPill } from "../components/ConnectionPill";
import { ProviderIcon } from "../components/ProviderIcon";
import type { Session, SessionSource } from "../../shared/types";

// ─── Provider multi-select dropdown ─────────────────────────────────────────

const PROVIDERS: { source: SessionSource; label: string }[] = [
  { source: "claude-code", label: "Claude Code" },
  { source: "cowork",      label: "Cowork" },
  { source: "cursor",      label: "Cursor" },
];

function ProvidersDropdown({
  selected,
  onChange,
}: {
  selected: Set<SessionSource>;
  onChange: (next: Set<SessionSource>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const allSelected = selected.size === 0 || selected.size === PROVIDERS.length;
  const label = allSelected
    ? "All providers"
    : PROVIDERS.filter((p) => selected.has(p.source))
        .map((p) => (p.source === "claude-code" ? "Claude" : p.label))
        .join(", ");

  function toggle(source: SessionSource) {
    const next = new Set(selected);
    if (next.has(source)) {
      next.delete(source);
    } else {
      next.add(source);
    }
    // If all checked or none left, reset to "all"
    onChange(next.size === 0 || next.size === PROVIDERS.length ? new Set() : next);
  }

  function toggleAll() {
    onChange(new Set());
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md font-medium transition-colors"
        style={{
          background: selected.size > 0 ? "var(--accent)" : "var(--bg-subtle)",
          color: selected.size > 0 ? "white" : "var(--text-muted)",
          border: `1px solid ${selected.size > 0 ? "var(--accent)" : "var(--border)"}`,
          maxWidth: "160px",
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="flex-shrink-0" style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 rounded-lg z-50 overflow-hidden"
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            minWidth: "160px",
          }}
        >
          {/* All option */}
          <label
            className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:opacity-80"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="accent-accent"
            />
            <span className="text-xs" style={{ color: "var(--text)" }}>All providers</span>
          </label>
          {PROVIDERS.map((p) => (
            <label
              key={p.source}
              className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:opacity-80"
            >
              <input
                type="checkbox"
                checked={allSelected || selected.has(p.source)}
                onChange={() => toggle(p.source)}
                className="accent-accent"
              />
              <ProviderIcon source={p.source} size={11} />
              <span className="text-xs" style={{ color: "var(--text)" }}>{p.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Project filter dropdown ─────────────────────────────────────────────────

function ProjectDropdown({
  projects,
  selected,
  onChange,
}: {
  projects: string[];
  selected: string | null;
  onChange: (p: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (projects.length === 0) return null;

  const label = selected
    ? selected.split("/").pop() ?? selected
    : "All projects";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md font-medium transition-colors"
        style={{
          background: selected ? "var(--bg-elevated)" : "var(--bg-subtle)",
          color: selected ? "var(--text)" : "var(--text-muted)",
          border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
          maxWidth: "160px",
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="flex-shrink-0" style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 rounded-lg z-50 overflow-hidden"
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            minWidth: "180px",
            maxHeight: "260px",
            overflowY: "auto",
          }}
        >
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs hover:opacity-80"
            style={{
              color: selected === null ? "var(--accent)" : "var(--text-muted)",
              borderBottom: "1px solid var(--border)",
              fontWeight: selected === null ? 600 : 400,
            }}
          >
            All projects
          </button>
          {projects.map((p) => {
            const shortName = p.split("/").pop() ?? p;
            const active = selected === p;
            return (
              <button
                key={p}
                onClick={() => { onChange(active ? null : p); setOpen(false); }}
                className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs hover:opacity-80 truncate"
                style={{
                  color: active ? "var(--accent)" : "var(--text)",
                  fontWeight: active ? 600 : 400,
                  display: "block",
                }}
                title={p}
              >
                {shortName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Grouped rendering ───────────────────────────────────────────────────────

interface ProjectGroup {
  label: string;
  sessions: Session[];
  latestKey: number;
}

function buildGroups(sessions: Session[]): ProjectGroup[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.projectLabel;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return [...map.entries()]
    .map(([label, list]) => ({
      label,
      sessions: list,
      latestKey: Math.max(...list.map(sessionSortKey)),
    }))
    .sort((a, b) => b.latestKey - a.latestKey);
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function SessionList() {
  const sessionsMap = useStore((s) => s.sessions);
  const connection = useStore((s) => s.connection);
  const [now, setNow] = useState(Date.now());
  const [selectedProviders, setSelectedProviders] = useState<Set<SessionSource>>(new Set());
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const sessions = useMemo(() => sortSessions(sessionsMap), [sessionsMap, now]);

  // Unique sorted project labels from all non-compacted sessions.
  const allProjects = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.status !== "compacted") seen.add(s.projectLabel);
    }
    return [...seen].sort();
  }, [sessions]);

  const totalCount = useMemo(
    () => sessions.filter((s) => s.status !== "compacted").length,
    [sessions],
  );

  const filtered = useMemo(() => {
    let list = sessions.filter((s) => {
      if (s.status === "compacted") return false;
      if (selectedProviders.size > 0 && !selectedProviders.has(s.source)) return false;
      if (selectedProject && s.projectLabel !== selectedProject) return false;
      return true;
    });
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
  }, [sessions, selectedProviders, selectedProject, query]);

  // Group sessions by project. Flat list when a single project is selected.
  const groups = useMemo<ProjectGroup[]>(() => {
    if (selectedProject) {
      return [{ label: selectedProject, sessions: filtered, latestKey: 0 }];
    }
    return buildGroups(filtered);
  }, [filtered, selectedProject]);

  const hasFilters = selectedProviders.size > 0 || selectedProject !== null || query.trim() !== "";

  return (
    <div className="flex flex-col flex-1 min-h-full">
      <header
        className="sticky top-0 z-20 safe-top safe-x px-4 pt-3 pb-2.5"
        style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}
      >
        {/* Row 1: title + count + connection + settings */}
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
              {filtered.length !== totalCount && (
                <span style={{ opacity: 0.6 }}> · {totalCount}</span>
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

        {/* Row 2: search */}
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

        {/* Row 3: filter dropdowns */}
        <div className="flex items-center gap-2">
          <ProvidersDropdown selected={selectedProviders} onChange={setSelectedProviders} />
          <ProjectDropdown
            projects={allProjects}
            selected={selectedProject}
            onChange={setSelectedProject}
          />
          {hasFilters && (
            <button
              onClick={() => { setSelectedProviders(new Set()); setSelectedProject(null); setQuery(""); }}
              className="text-xs px-2 py-1.5 rounded-md ml-auto"
              style={{ color: "var(--text-faint)", background: "var(--bg-subtle)", border: "1px solid var(--border)" }}
            >
              Clear
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto safe-bottom" style={{ background: "var(--bg)" }}>
        {filtered.length === 0 ? (
          <EmptyState
            hasFilters={hasFilters}
            totalCount={totalCount}
            onClear={() => { setSelectedProviders(new Set()); setSelectedProject(null); setQuery(""); }}
          />
        ) : selectedProject ? (
          // Single project selected — flat list, no header
          <ul>
            {filtered.map((s) => (
              <li key={s.id}>
                <SessionRow session={s} now={now} />
              </li>
            ))}
          </ul>
        ) : (
          // Grouped by project
          <div>
            {groups.map((group) => (
              <section key={group.label}>
                {groups.length > 1 && (
                  <div
                    className="px-4 py-1.5 flex items-center gap-2"
                    style={{
                      background: "var(--bg-subtle)",
                      borderBottom: "1px solid var(--border)",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <span
                      className="text-[11px] font-semibold tracking-wide truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {group.label.split("/").pop() ?? group.label}
                    </span>
                    <span
                      className="text-[10px] tabular-nums ml-auto flex-shrink-0"
                      style={{ color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}
                    >
                      {group.sessions.length}
                    </span>
                  </div>
                )}
                <ul>
                  {group.sessions.map((s) => (
                    <li key={s.id}>
                      <SessionRow session={s} now={now} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  hasFilters,
  totalCount,
  onClear,
}: {
  hasFilters: boolean;
  totalCount: number;
  onClear: () => void;
}) {
  if (totalCount === 0) {
    return (
      <div className="px-6 pt-16 text-center">
        <div className="text-4xl mb-2">·</div>
        <h2 className="text-base font-medium mb-1" style={{ color: "var(--text)" }}>
          Nothing yet
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Start a Claude Code or Cursor session on your desktop — it'll appear here in real time.
        </p>
      </div>
    );
  }
  return (
    <div className="px-6 pt-16 text-center">
      <h2 className="text-base font-medium mb-1" style={{ color: "var(--text)" }}>
        No matching sessions
      </h2>
      {hasFilters && (
        <button
          onClick={onClear}
          className="text-sm px-3 py-2 rounded-md mt-3"
          style={{ background: "var(--accent)", color: "white" }}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
