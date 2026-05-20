/**
 * CursorProvider — surfaces Cursor IDE chat sessions in fleetwatch.
 *
 * Data lives in a single ~30 GB SQLite DB at
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * with two key namespaces in the `cursorDiskKV` table:
 *
 *   - composerData:<conversationId>       — session envelope (title, timestamps, files)
 *   - bubbleId:<conversationId>:<msgId>   — individual user/assistant messages
 *
 * We open the DB read-only (Cursor can be running concurrently) and use
 * fs.watch on the WAL/main file as a cheap change signal — when WAL is
 * rewritten on commit, we re-scan envelopes and (for subscribed sessions)
 * fetch any new bubbles by rowid.
 *
 * To keep the session list manageable we cap surfaced composers to a small
 * recent window (COMPOSER_LIMIT). Bubbles for a given session are only
 * loaded when a client subscribes, mirroring the JSONL provider.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, watch as fsWatch, FSWatcher as NativeFSWatcher } from "node:fs";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { BaseProvider, type BaseProviderOptions, type ProviderInfo } from "./base.js";
import type { SessionEvent } from "../../shared/types.js";

const HOME = os.homedir();
export const CURSOR_DB_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);

/** How many composers to surface in the session list (most recent first). */
const COMPOSER_LIMIT = 200;
/** Wait this long after a WAL change before re-polling, to coalesce bursts. */
const WAL_DEBOUNCE_MS = 500;

interface CursorSessionState {
  composerId: string;
  /** Last DB rowid we've ingested for this composer's bubbles. */
  lastSeenRowid: number;
}

export interface CursorProviderOptions extends BaseProviderOptions {
  /** Override DB path (for tests / unusual installs). */
  dbPath?: string;
  /** Max composers to surface. Defaults to 200. */
  limit?: number;
}

export class CursorProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "cursor",
    displayName: "Cursor",
    description: "Cursor IDE chat sessions from the local SQLite store.",
    accentColor: "#5fb9ff",
  };

  private db: DB | null = null;
  private walWatcher: NativeFSWatcher | null = null;
  private dbWatcher: NativeFSWatcher | null = null;
  /** Override from options — null means "use discovery to find it". */
  private readonly dbPathOverride: string | null;
  /** Resolved at start(). */
  private dbPath: string | null = null;
  private readonly limit: number;
  /** All composers we know about (whether subscribed or not). */
  private sessions = new Map<string, CursorSessionState>();
  /** sessionIds a client is currently watching → drives bubble polling. */
  private subscribed = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(opts: CursorProviderOptions) {
    super(opts);
    this.dbPathOverride = opts.dbPath ?? null;
    this.limit = opts.limit ?? COMPOSER_LIMIT;
  }

  protected async onStart(): Promise<void> {
    // Locate the state.vscdb. Two layers:
    //   1. Explicit override (from CursorProviderOptions) — wins immediately.
    //   2. Discovery: walk known per-OS paths, then bounded filesystem search.
    //
    // The `verify` predicate opens each candidate as SQLite and checks for the
    // `cursorDiskKV` table — VSCode uses a `state.vscdb` too (different schema)
    // so a substring match on the path alone would mis-identify it.
    if (this.dbPathOverride) {
      this.dbPath = this.dbPathOverride;
    } else {
      this.dbPath = await this.discover({
        label: "Cursor globalStorage DB",
        candidates: [
          process.env.CURSOR_DB_PATH,
          CURSOR_DB_PATH,
          // Linux (VSCode-fork convention)
          path.join(HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
          // Windows
          process.env.APPDATA && path.join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"),
        ],
        searchRoots: [
          // macOS app data
          path.join(HOME, "Library", "Application Support"),
          // Linux app data
          path.join(HOME, ".config"),
        ],
        searchName: "state.vscdb",
        // Prevent VSCode / VSCodium / Codium / etc state.vscdb files from
        // matching when verify can't open them.
        pathMustContain: "Cursor",
        searchMaxDepth: 5,
        verify: verifyCursorDb,
      });
    }
    if (!this.dbPath) {
      this.skipStartup("no Cursor SQLite DB found");
      return;
    }
    if (!existsSync(this.dbPath)) {
      this.skipStartup(`Cursor DB not at ${this.dbPath}`);
      return;
    }
    try {
      // readonly: true → opens the DB without acquiring a write lock; safe
      // while Cursor is running (Cursor uses WAL mode so reads don't block).
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      this.log(`failed to open db: ${(err as Error).message}`);
      this.skipStartup("could not open Cursor DB");
      return;
    }

    this.scanComposers();
    this.watchForChanges();
    this.log(`surfaced ${this.sessions.size} session(s) from ${this.dbPath}`);
  }

  protected async onStop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    try { this.walWatcher?.close(); } catch {}
    try { this.dbWatcher?.close(); } catch {}
    this.walWatcher = null;
    this.dbWatcher = null;
    try { this.db?.close(); } catch {}
    this.db = null;
  }

  async backfillSession(sessionId: string): Promise<void> {
    // No-op when this isn't our session — the ProviderManager fan-out pattern
    // means every provider is asked for every subscription.
    if (!this.sessions.has(sessionId) || !this.db) return;
    this.subscribed.add(sessionId);
    this.loadBubbles(sessionId);
  }

  /** Read the most-recent composer envelopes and upsert them into the registry. */
  private scanComposers(): void {
    if (!this.db) return;
    let rows: Array<{ key: string; value: string }>;
    try {
      // Range scan: 'composerData:' ≤ key < 'composerData;' lets SQLite use the
      // implicit index on `key` (UNIQUE → sqlite_autoindex_cursorDiskKV_1)
      // regardless of LIKE's case sensitivity defaults. Massive speedup on a
      // 1.9M-row table — turns a SCAN into a SEARCH.
      //
      // ORDER BY rowid DESC = newest first: ON CONFLICT REPLACE means every
      // composer update inserts a new row with a higher rowid, so this gives
      // us the most-recently-modified composers.
      const stmt = this.db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' ORDER BY rowid DESC LIMIT ?",
      );
      rows = stmt.all(this.limit) as Array<{ key: string; value: string }>;
    } catch (err) {
      this.log(`scanComposers failed: ${(err as Error).message}`);
      return;
    }
    for (const row of rows) {
      try {
        this.upsertComposerFromJson(row.value);
      } catch (err) {
        // Skip malformed entries; one bad row shouldn't kill the scan.
      }
    }
  }

  private upsertComposerFromJson(json: string): void {
    const parsed = JSON.parse(json);
    if (typeof parsed.composerId !== "string") return;
    const composerId: string = parsed.composerId;
    const name = typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : undefined;
    const subtitle = typeof parsed.subtitle === "string" ? parsed.subtitle : undefined;
    const createdAt = numericTs(parsed.createdAt);
    const lastUpdatedAt = numericTs(parsed.conversationCheckpointLastUpdatedAt) ?? createdAt ?? 0;

    const projectLabel = labelFromOriginalFileStates(parsed.originalFileStates) ?? "Cursor";
    const projectPath = projectPathFromOriginalFileStates(parsed.originalFileStates) ?? "cursor";

    const isSubagent = parsed.subagentInfo && typeof parsed.subagentInfo.subagentType === "string";
    const parentSessionId = parsed.subagentInfo?.parentComposerId;

    this.registry.upsertMeta(composerId, {
      filePath: `cursor:${composerId}`,
      projectPath,
      projectLabel,
      source: "cursor",
      isSubagent: !!isSubagent,
      parentSessionId: typeof parentSessionId === "string" ? parentSessionId : undefined,
    });

    if (name) {
      this.registry.setTitle(composerId, { aiTitle: name });
    }

    // Seed sort-order metrics so the session appears in the list at the right
    // place even before any bubbles are loaded. lastUserMessageAt drives the
    // sort; lastEventAt drives status derivation (>IDLE_THRESHOLD → idle).
    const headers = Array.isArray(parsed.fullConversationHeadersOnly)
      ? parsed.fullConversationHeadersOnly
      : [];
    const eventCount = headers.length;
    if (lastUpdatedAt > 0) {
      this.registry.setUserMessageFromHistory(
        projectPath,
        composerId,
        lastUpdatedAt,
        subtitle ?? name ?? "Cursor conversation",
      );
      this.registry.setActivity(composerId, {
        lastEventAt: lastUpdatedAt,
        eventCount,
      });
    }

    if (!this.sessions.has(composerId)) {
      this.sessions.set(composerId, { composerId, lastSeenRowid: 0 });
    }
  }

  /** Load (or top-up) bubbles for a single composer into the registry. */
  private loadBubbles(composerId: string): void {
    if (!this.db) return;
    const state = this.sessions.get(composerId);
    if (!state) return;
    let rows: Array<{ rowid: number; value: string }>;
    try {
      // Range scan on key: `bubbleId:<id>:` ≤ key < `bubbleId:<id>;`
      // Uses the autoindex for an O(log n) seek instead of full SCAN.
      const lo = `bubbleId:${composerId}:`;
      const hi = `bubbleId:${composerId};`;
      const stmt = this.db.prepare(
        "SELECT rowid, value FROM cursorDiskKV WHERE key >= ? AND key < ? AND rowid > ? ORDER BY rowid",
      );
      rows = stmt.all(lo, hi, state.lastSeenRowid) as Array<{
        rowid: number;
        value: string;
      }>;
    } catch (err) {
      this.log(`loadBubbles failed: ${(err as Error).message}`);
      return;
    }
    for (const row of rows) {
      try {
        const ev = bubbleToEvent(row.value, composerId, row.rowid);
        if (ev) this.registry.appendEvent(composerId, ev);
      } catch {}
      if (row.rowid > state.lastSeenRowid) state.lastSeenRowid = row.rowid;
    }
  }

  /** Watch WAL / DB for changes; on change, re-poll subscribed sessions. */
  private watchForChanges(): void {
    if (!this.dbPath) return;
    const dbPath = this.dbPath;
    const walPath = `${dbPath}-wal`;
    const trigger = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.poll();
      }, WAL_DEBOUNCE_MS);
    };
    try {
      // WAL gets rewritten on every commit while Cursor is running.
      if (existsSync(walPath)) {
        this.walWatcher = fsWatch(walPath, () => trigger());
      }
      // Fallback: also watch the main file in case WAL is checkpointed away.
      this.dbWatcher = fsWatch(dbPath, () => trigger());
    } catch (err) {
      this.log(`watch failed: ${(err as Error).message}`);
    }
  }

  private poll(): void {
    if (!this.db) return;
    // Re-scan envelopes — picks up new composers + updated activity timestamps.
    this.scanComposers();
    // For subscribed sessions, ingest any new bubbles.
    for (const id of this.subscribed) {
      this.loadBubbles(id);
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Disambiguate Cursor's state.vscdb from VSCode's (which has the same
 * filename but a different schema). Opens read-only, checks for both:
 *   - the `cursorDiskKV` table (unique to Cursor)
 *   - at least one `composerData:` or `bubbleId:` key inside it
 *
 * Returns false on any failure — never throws.
 */
async function verifyCursorDb(file: string): Promise<boolean> {
  let db: DB | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get() as { name?: string } | undefined;
    if (!row?.name) return false;
    // One narrow probe — confirms the table is populated with the Cursor key shape.
    const probe = db
      .prepare(
        "SELECT 1 FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' LIMIT 1",
      )
      .get();
    return !!probe;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}


function bubbleToEvent(json: string, sessionId: string, rowid: number): SessionEvent | null {
  const parsed = JSON.parse(json);
  const type =
    parsed.type === 1 ? "user" :
    parsed.type === 2 ? "assistant" :
    null;
  if (!type) return null;
  // Cursor occasionally synthesizes user-side notifications; skip pure noise.
  const text =
    typeof parsed.text === "string" && parsed.text.length > 0
      ? parsed.text
      : typeof parsed.richText === "string" && parsed.richText.length > 0
        ? parsed.richText
        : undefined;
  const thinking = typeof parsed.thinking === "string" ? parsed.thinking : undefined;
  if (!text && !thinking) return null;
  const ts = numericTs(parsed.createdAt) ?? Date.now();
  return {
    sessionId,
    ts,
    type,
    text,
    thinking,
    // Use bubbleId for stable de-dup on the client.
    uuid: typeof parsed.bubbleId === "string" ? parsed.bubbleId : `cursor:${sessionId}:${rowid}`,
  };
}

function numericTs(v: unknown): number | undefined {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : undefined;
  }
  return undefined;
}

/**
 * Derive a short "project / folder" label from the set of file URIs that
 * Cursor recorded for this conversation. We take the longest common
 * directory prefix and use its trailing one or two segments.
 */
function labelFromOriginalFileStates(states: unknown): string | undefined {
  const prefix = commonPathPrefix(states);
  if (!prefix) return undefined;
  const segs = prefix.split("/").filter(Boolean);
  if (segs.length >= 2) return `${segs[segs.length - 2]} / ${segs[segs.length - 1]}`;
  return segs[segs.length - 1];
}

function projectPathFromOriginalFileStates(states: unknown): string | undefined {
  return commonPathPrefix(states) || undefined;
}

function commonPathPrefix(states: unknown): string {
  if (!states || typeof states !== "object") return "";
  const keys = Object.keys(states as Record<string, unknown>);
  if (keys.length === 0) return "";
  const stripped = keys.map((k) => k.replace(/^file:\/\//, ""));
  if (stripped.length === 1) {
    // For a single file, return its directory.
    const idx = stripped[0].lastIndexOf("/");
    return idx >= 0 ? stripped[0].slice(0, idx) : stripped[0];
  }
  // Find longest common prefix, then truncate at last '/'.
  let prefix = stripped[0];
  for (let i = 1; i < stripped.length; i++) {
    while (stripped[i].indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  // Make sure prefix is a directory boundary.
  const idx = prefix.lastIndexOf("/");
  return idx > 0 ? prefix.slice(0, idx) : prefix;
}
