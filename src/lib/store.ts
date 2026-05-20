import { create } from "zustand";
import type { Session, SessionEvent } from "../../shared/types";

interface ConnectionState {
  status: "disconnected" | "connecting" | "connected" | "unauthorized" | "error";
  hostname?: string;
  platform?: string;
  agentVersion?: string;
  lastError?: string;
}

interface StoreShape {
  token: string | null;
  setToken: (t: string | null) => void;

  connection: ConnectionState;
  setConnection: (c: ConnectionState) => void;

  sessions: Record<string, Session>;
  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setSessions: (list: Session[]) => void;

  // Most recent N events per session, kept in memory for the detail view.
  events: Record<string, SessionEvent[]>;
  appendEvent: (e: SessionEvent) => void;
  setEvents: (id: string, events: SessionEvent[]) => void;

  reset: () => void;
}

const STORAGE_KEY = "cw.token.v1";

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch {}
}
function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch {}
}

/**
 * Read the initial JWT from localStorage. The URL ?token= is the pairing
 * token (not a JWT) — the Pair screen exchanges it for a JWT via /api/login.
 */
function getInitialToken(): string | null {
  return lsGet(STORAGE_KEY);
}

export const useStore = create<StoreShape>((set) => ({
  token: getInitialToken(),
  setToken: (t) => {
    if (t) lsSet(STORAGE_KEY, t); else lsRemove(STORAGE_KEY);
    set({ token: t });
  },

  connection: { status: "disconnected" },
  setConnection: (c) => set({ connection: c }),

  sessions: {},
  upsertSession: (s) =>
    set((prev) => ({
      sessions: { ...prev.sessions, [s.id]: s },
    })),
  removeSession: (id) =>
    set((prev) => {
      const next = { ...prev.sessions };
      delete next[id];
      const evNext = { ...prev.events };
      delete evNext[id];
      return { sessions: next, events: evNext };
    }),
  setSessions: (list) =>
    set(() => {
      const map: Record<string, Session> = {};
      for (const s of list) map[s.id] = s;
      return { sessions: map };
    }),

  events: {},
  appendEvent: (e) =>
    set((prev) => {
      const existing = prev.events[e.sessionId] ?? [];
      // de-dupe by uuid when present
      const dedup =
        e.uuid && existing.some((x) => x.uuid === e.uuid) ? existing : [...existing, e];
      const trimmed = dedup.length > 800 ? dedup.slice(dedup.length - 800) : dedup;
      return { events: { ...prev.events, [e.sessionId]: trimmed } };
    }),
  setEvents: (id, events) =>
    set((prev) => ({ events: { ...prev.events, [id]: events.slice() } })),

  reset: () =>
    set({
      sessions: {},
      events: {},
      connection: { status: "disconnected" },
    }),
}));

const ACTIVE_STATUSES = new Set<string>(["running", "running-tool", "awaiting-user", "errored"]);

/**
 * Returns the timestamp used for sorting a session.
 * Active sessions: last user message (most relevant moment).
 * Idle sessions: last event of any kind (last activity, even if agent).
 */
export function sessionSortKey(s: Session): number {
  if (ACTIVE_STATUSES.has(s.status)) return s.lastUserMessageAt || s.lastEventAt;
  return s.lastEventAt;
}

/**
 * Sort sessions. Float recent errored sessions to the top.
 * Pure: callers should pass the sessions object from the store and memoize
 * the result (returning a new array on every call breaks zustand v5's
 * useSyncExternalStore snapshot invariant).
 */
export function sortSessions(sessions: Record<string, Session>): Session[] {
  const now = Date.now();
  return Object.values(sessions).sort((a, b) => {
    const aErr = a.status === "errored" && now - a.lastEventAt < 5 * 60_000;
    const bErr = b.status === "errored" && now - b.lastEventAt < 5 * 60_000;
    if (aErr && !bErr) return -1;
    if (bErr && !aErr) return 1;
    return sessionSortKey(b) - sessionSortKey(a);
  });
}
