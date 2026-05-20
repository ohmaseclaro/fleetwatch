import { EventEmitter } from "node:events";
import type { Session, SessionStatus, SessionEvent } from "../shared/types.js";

const HISTORY_BUFFER = 500; // keep the last N events per session in memory for replays
const IDLE_THRESHOLD_MS = 60_000;
const RUNNING_FRESHNESS_MS = 5_000;

interface InternalSession {
  session: Session;
  events: SessionEvent[];
  subscribed: boolean;
  // for status derivation:
  lastToolUseId?: string;
  lastToolUseName?: string;
  toolUseHasResult: Set<string>;
  lastAssistantStop?: string;
  lastWasError?: boolean;
  lastWasSummary?: boolean;
  filePath: string;
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, InternalSession>();

  upsertMeta(
    sessionId: string,
    init: {
      filePath: string;
      projectPath: string;
      projectLabel: string;
      source: Session["source"];
      isSubagent?: boolean;
      parentSessionId?: string;
      gitBranch?: string;
    },
  ): InternalSession {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const session: Session = {
        id: sessionId,
        projectPath: init.projectPath,
        projectLabel: init.projectLabel,
        status: "idle",
        lastUserMessageAt: 0,
        lastEventAt: 0,
        lastUserMessagePreview: "",
        isSubagent: !!init.isSubagent,
        parentSessionId: init.parentSessionId,
        source: init.source,
        gitBranch: init.gitBranch,
        eventCount: 0,
      };
      entry = {
        session,
        events: [],
        subscribed: false,
        toolUseHasResult: new Set(),
        filePath: init.filePath,
      };
      this.sessions.set(sessionId, entry);
      this.emit("upsert", session);
    } else {
      let changed = false;
      if (entry.session.projectPath !== init.projectPath) {
        entry.session.projectPath = init.projectPath;
        changed = true;
      }
      if (entry.session.projectLabel !== init.projectLabel) {
        entry.session.projectLabel = init.projectLabel;
        changed = true;
      }
      if (init.gitBranch && entry.session.gitBranch !== init.gitBranch) {
        entry.session.gitBranch = init.gitBranch;
        changed = true;
      }
      entry.filePath = init.filePath;
      if (changed) this.emit("upsert", entry.session);
    }
    return entry;
  }

  setTitle(sessionId: string, patch: { aiTitle?: string; customTitle?: string }): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    let changed = false;
    if (patch.aiTitle && entry.session.aiTitle !== patch.aiTitle) {
      entry.session.aiTitle = patch.aiTitle;
      changed = true;
    }
    if (patch.customTitle && entry.session.customTitle !== patch.customTitle) {
      entry.session.customTitle = patch.customTitle;
      changed = true;
    }
    if (changed) this.emit("upsert", entry.session);
  }

  /** Mark a session as actively subscribed by a client, enabling event buffering. */
  subscribe(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.subscribed = true;
  }

  /** Unsubscribe: stop buffering events (clears the ring buffer to reclaim memory). */
  unsubscribe(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.subscribed = false;
      entry.events = [];
    }
  }

  isSubscribed(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.subscribed ?? false;
  }

  appendEvent(sessionId: string, event: SessionEvent): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Only buffer events for subscribed sessions to cap memory.
    if (entry.subscribed) {
      entry.events.push(event);
      if (entry.events.length > HISTORY_BUFFER) entry.events.splice(0, entry.events.length - HISTORY_BUFFER);
    }

    const s = entry.session;
    s.eventCount += 1;
    if (event.ts > s.lastEventAt) s.lastEventAt = event.ts;

    if (event.type === "user" && event.text) {
      // Skip slash commands & internal hooks for the "last human message" notion.
      const isHumanText = !event.text.startsWith("<command-name>") && !event.text.startsWith("<local-command-stdout>");
      if (isHumanText) {
        s.lastUserMessageAt = event.ts;
        s.lastUserMessagePreview = previewOf(event.text);
      }
    }

    // Status state updates — each event resets prior flags so the state always
    // reflects the most recent meaningful turn.
    if (event.type === "tool_use") {
      entry.lastToolUseId = event.toolUseId;
      entry.lastToolUseName = event.toolName;
      entry.lastWasError = false;
      entry.lastWasSummary = false;
      entry.lastAssistantStop = undefined;
    } else if (event.type === "tool_result") {
      if (event.toolUseRef) entry.toolUseHasResult.add(event.toolUseRef);
      entry.lastWasError = event.toolResultIsError === true;
    } else if (event.type === "assistant") {
      entry.lastAssistantStop = "end_turn";
      entry.lastWasError = false;
      entry.lastWasSummary = false;
    } else if (event.type === "user") {
      // New user prompt — reset error flag, assistant hasn't replied yet.
      entry.lastWasError = false;
      entry.lastWasSummary = false;
      entry.lastAssistantStop = undefined;
    } else if (event.type === "summary") {
      entry.lastWasSummary = true;
    }
    // We deliberately ignore system events for status derivation — they're
    // mostly hooks / reminders / warnings, not errors.

    this.recomputeStatus(entry);
    this.emit("event", event);
    this.emit("upsert", entry.session);
  }

  setUserMessageFromHistory(projectPath: string, sessionId: string, ts: number, preview: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (ts > entry.session.lastUserMessageAt) {
      entry.session.lastUserMessageAt = ts;
      entry.session.lastUserMessagePreview = preview;
      this.emit("upsert", entry.session);
    }
  }

  /**
   * Sync per-session metrics from a non-event source (e.g. Cursor's
   * `composerData` envelopes which carry timestamps but no events until the
   * session is opened). Used to seed sort-order before subscription.
   */
  setActivity(
    sessionId: string,
    opts: { lastEventAt?: number; eventCount?: number; currentActivity?: string },
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    let changed = false;
    if (opts.lastEventAt !== undefined && opts.lastEventAt > entry.session.lastEventAt) {
      entry.session.lastEventAt = opts.lastEventAt;
      changed = true;
    }
    if (opts.eventCount !== undefined && opts.eventCount !== entry.session.eventCount) {
      entry.session.eventCount = opts.eventCount;
      changed = true;
    }
    if (opts.currentActivity !== undefined && entry.session.currentActivity !== opts.currentActivity) {
      entry.session.currentActivity = opts.currentActivity;
      changed = true;
    }
    if (changed) {
      this.recomputeStatus(entry);
      this.emit("upsert", entry.session);
    }
  }

  recomputeAll(): void {
    for (const entry of this.sessions.values()) {
      this.recomputeStatus(entry);
    }
  }

  recomputeStatus(entry: InternalSession): void {
    const prev = entry.session.status;
    const next = deriveStatus(entry);
    if (prev !== next.status || entry.session.currentActivity !== next.currentActivity) {
      entry.session.status = next.status;
      entry.session.currentActivity = next.currentActivity;
      this.emit("upsert", entry.session);
    }
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
      .map((e) => e.session)
      .sort(sortSessions);
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * Where this session's transcript lives on disk. For JSONL providers
   * (Claude Code, Cowork) it's an actual path. For Cursor we use a synthetic
   * `cursor:<composerId>` token so the UI can show "lives in the Cursor
   * SQLite DB" instead of a misleading non-existent file.
   */
  filePathOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.filePath;
  }

  history(sessionId: string, limit?: number): SessionEvent[] {
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];
    if (limit && entry.events.length > limit) {
      return entry.events.slice(entry.events.length - limit);
    }
    return entry.events.slice();
  }

  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.emit("remove", sessionId);
  }
}

const ERROR_FRESHNESS_MS = 5 * 60_000;

function deriveStatus(entry: InternalSession): { status: SessionStatus; currentActivity?: string } {
  const s = entry.session;
  const now = Date.now();
  const ageMs = now - (s.lastEventAt || now);

  if (entry.lastToolUseId && !entry.toolUseHasResult.has(entry.lastToolUseId)) {
    // Only show as running-tool if the call is fresh — otherwise treat as idle.
    if (ageMs < IDLE_THRESHOLD_MS) {
      return {
        status: "running-tool",
        currentActivity: `Running ${entry.lastToolUseName ?? "tool"}…`,
      };
    }
  }
  if (entry.lastWasSummary) {
    return { status: "compacted", currentActivity: "Session compacted" };
  }
  // Errors are only sticky if recent — old sessions go to idle instead of staying red forever.
  if (entry.lastWasError && ageMs < ERROR_FRESHNESS_MS) {
    return { status: "errored", currentActivity: "Error" };
  }
  if (entry.lastAssistantStop === "end_turn") {
    if (ageMs < RUNNING_FRESHNESS_MS) {
      return { status: "running", currentActivity: "Finishing turn…" };
    }
    if (ageMs < IDLE_THRESHOLD_MS) {
      return { status: "awaiting-user", currentActivity: "Waiting for you" };
    }
    return { status: "idle" };
  }
  if (s.lastEventAt > 0 && ageMs > IDLE_THRESHOLD_MS) {
    return { status: "idle" };
  }
  return { status: "running", currentActivity: "Working…" };
}

function previewOf(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
}

export function sortSessions(a: Session, b: Session): number {
  // errored sessions in the last 5 min float to the top
  const now = Date.now();
  const aErrRecent = a.status === "errored" && now - a.lastEventAt < 5 * 60_000;
  const bErrRecent = b.status === "errored" && now - b.lastEventAt < 5 * 60_000;
  if (aErrRecent && !bErrRecent) return -1;
  if (bErrRecent && !aErrRecent) return 1;
  return (b.lastUserMessageAt || b.lastEventAt) - (a.lastUserMessageAt || a.lastEventAt);
}
