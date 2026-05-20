import { promises as fs, watch as fsWatch, FSWatcher as NativeFSWatcher } from "node:fs";
import path from "node:path";
import os from "node:os";
import chokidar, { FSWatcher } from "chokidar";
import { parseLineMulti, parseTitleLine } from "./jsonl.js";
import { attachmentStore } from "./attachmentStore.js";
import { readDelta, readEntireFile, readHeadTail, readTailLines, TailState } from "./tail.js";
import { decodeProjectDir } from "./projectPath.js";
import { BaseProvider, type BaseProviderOptions, type ProviderInfo } from "./providers/base.js";

const HOME = os.homedir();
/** Default location — most installs use this. */
export const CLAUDE_PROJECTS_DIR = path.join(HOME, ".claude", "projects");
export const COWORK_DIR = path.join(
  HOME,
  "Library",
  "Application Support",
  "Claude",
  "local-agent-mode-sessions",
);
export const HISTORY_FILE = path.join(HOME, ".claude", "history.jsonl");

/**
 * Quick-and-cheap predicate: does a JSONL file look like a Claude-family
 * session log (Claude Code OR Cowork — they share the format but differ in
 * casing)? Reads at most the first KB and checks for shape markers:
 *
 *   - `type: user/assistant/...` (always present)
 *   - `message: {...}` (the canonical event envelope) OR any of the
 *     known id fields (camelCase from Claude Code, snake_case from Cowork)
 *
 * False negatives (we don't recognize a real Claude file) are rare; false
 * positives are unlikely because random JSONL files don't carry the exact
 * type values we look for.
 */
async function looksLikeClaudeJsonl(file: string): Promise<boolean> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(1024);
    await fh.read(buf, 0, buf.length, 0);
    const text = buf.toString("utf8");
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("{")) return false;
    const hasKnownType = /"type"\s*:\s*"(user|assistant|summary|tool_use|tool_result)"/.test(firstLine);
    if (!hasKnownType) return false;
    // Accept any of the id-shape fields we've seen across Claude Code,
    // Cowork, and skill subagent variants.
    const hasIdMarker =
      /"message"\s*:/.test(firstLine) ||
      /"parentUuid"/.test(firstLine) ||
      /"promptId"/.test(firstLine) ||
      /"sessionId"/.test(firstLine) ||
      /"session_id"/.test(firstLine) ||
      /"parent_uuid"/.test(firstLine) ||
      /"parent_tool_use_id"/.test(firstLine);
    return hasIdMarker;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Verify a directory looks like a Claude/Cowork sessions root: contains at
 * least one *.jsonl file (possibly nested) whose first line passes
 * looksLikeClaudeJsonl. Walks only 3 levels deep to stay fast.
 */
async function verifyClaudeStyleDir(dir: string, maxDepth = 3): Promise<boolean> {
  const found = await findFirstJsonl(dir, maxDepth, 0);
  if (!found) return false;
  return looksLikeClaudeJsonl(found);
}

async function findFirstJsonl(dir: string, maxDepth: number, depth: number): Promise<string | null> {
  if (depth > maxDepth) return null;
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as any;
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) return full;
    if (entry.isDirectory()) {
      const sub = await findFirstJsonl(full, maxDepth, depth + 1);
      if (sub) return sub;
    }
  }
  return null;
}

interface FileEntry {
  filePath: string;
  sessionId: string;
  source: "claude-code" | "cowork";
  projectPath: string;
  projectLabel: string;
  isSubagent: boolean;
  parentSessionId?: string;
  state: TailState | null;
  pending: boolean;
  queued: boolean;
  /**
   * Per-file native watcher. Uses node's `fs.watch` (kqueue/inotify) directly
   * on each session file, which is more reliable than chokidar's directory-
   * level fsevents on macOS for detecting appends to deep files. Null when
   * the watcher is closed or hasn't been attached yet.
   */
  fileWatcher: NativeFSWatcher | null;
}

export interface WatcherOptions extends BaseProviderOptions {
  /** @deprecated Cowork is now always scanned when the directory exists. */
  includeCowork?: boolean;
  excludePathPrefixes?: string[];
}

/**
 * Tails Claude Code (~/.claude/projects) AND Cowork JSONL files. Both share
 * the same on-disk format so they're handled by one provider — sessions
 * are emitted with their correct `source` (claude-code | cowork) field.
 */
export class Watcher extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "claude-code",
    displayName: "Claude",
    description: "Claude Code sessions in ~/.claude/projects (and Cowork sessions if present).",
    accentColor: "var(--accent)",
  };

  private files = new Map<string, FileEntry>();
  private projectWatcher: FSWatcher | null = null;
  private coworkWatcher: FSWatcher | null = null;
  private historyWatcher: FSWatcher | null = null;
  private historyState: TailState | null = null;
  private projectByPath = new Map<string, { projectPath: string; projectLabel: string }>();
  private readonly excludePathPrefixes: string[];
  /** Polling reconciliation timer — catches fs events chokidar misses. */
  private pollTimer: NodeJS.Timeout | null = null;
  /** Directory rescan timer — catches new session files chokidar misses. */
  private rescanTimer: NodeJS.Timeout | null = null;

  constructor(opts: WatcherOptions) {
    super(opts);
    this.excludePathPrefixes = opts.excludePathPrefixes ?? [];
  }

  /** Resolved at start() — null when the default isn't there and no fallback exists. */
  private claudeDir: string | null = null;
  private coworkDir: string | null = null;
  private historyFile: string | null = null;

  protected async onStart(): Promise<void> {
    // --- Discover Claude Code projects dir ---------------------------------
    this.claudeDir = await this.discover({
      label: "Claude projects dir",
      candidates: [
        process.env.CLAUDE_PROJECTS_DIR,
        CLAUDE_PROJECTS_DIR,                               // ~/.claude/projects (default)
        path.join(HOME, ".config", "claude", "projects"),  // XDG-ish (Linux)
        path.join(HOME, "Library", "Application Support", "Claude", "projects"),
      ],
      searchRoots: [HOME],
      searchName: "projects",
      pathMustContain: ".claude",
      // Generous depth: handle non-standard installs like
      // ~/Workspaces/something/.claude/projects without being so wide that
      // we walk huge user trees.
      searchMaxDepth: 6,
      verify: async (p) => {
        // Must be a directory AND look like Claude session data.
        try {
          const st = await fs.stat(p);
          if (!st.isDirectory()) return false;
        } catch {
          return false;
        }
        return verifyClaudeStyleDir(p);
      },
    });
    if (this.claudeDir) {
      await fs.mkdir(this.claudeDir, { recursive: true }).catch(() => {});
      await this.initialScan(this.claudeDir, "claude-code");
    } else {
      this.log(`no Claude projects dir found — Claude Code sessions disabled`);
    }

    // --- Discover Cowork dir (always optional) -----------------------------
    this.coworkDir = await this.discover({
      label: "Cowork sessions dir",
      candidates: [
        process.env.COWORK_DIR,
        COWORK_DIR,
        path.join(HOME, ".config", "claude", "local-agent-mode-sessions"),
      ],
      searchRoots: [
        path.join(HOME, "Library", "Application Support"),
        path.join(HOME, ".config"),
      ],
      searchName: "local-agent-mode-sessions",
      pathMustContain: "local-agent-mode-sessions",
      searchMaxDepth: 5,
      verify: async (p) => {
        try {
          const st = await fs.stat(p);
          if (!st.isDirectory()) return false;
        } catch {
          return false;
        }
        // Cowork shares Claude's JSONL format — same verifier. The
        // pathMustContain constraint above is what keeps us from picking up
        // Claude Code's dir by mistake. Cowork nests deeper than Claude
        // (install-id/install-id/local_*/<uuid>.jsonl), so allow more depth.
        return verifyClaudeStyleDir(p, 5);
      },
    });
    if (this.coworkDir) {
      await this.initialScan(this.coworkDir, "cowork");
    }

    // --- Discover the history.jsonl file (cwd → preview ordering) ----------
    const defaultHistory = this.claudeDir
      ? path.join(path.dirname(this.claudeDir), "history.jsonl")
      : HISTORY_FILE;
    this.historyFile = await this.discover({
      label: "Claude history.jsonl",
      candidates: [
        process.env.CLAUDE_HISTORY_FILE,
        defaultHistory,
        HISTORY_FILE,
      ],
      verify: async (p) => {
        try {
          const st = await fs.stat(p);
          return st.isFile();
        } catch { return false; }
      },
    });
    if (this.historyFile) {
      await this.primeHistory();
    }

    // --- Wire chokidar watchers for everything we discovered ---------------
    if (this.claudeDir) {
      this.projectWatcher = chokidar
        .watch(this.claudeDir, {
          ignored: (p: string) => p.endsWith(".tmp") || p.includes("/.DS_Store"),
          persistent: true,
          ignoreInitial: true,
          depth: 10,
        })
        .on("add", (p: string) => this.onFileChange(p, "claude-code", "add"))
        .on("change", (p: string) => this.onFileChange(p, "claude-code", "change"))
        .on("unlink", (p: string) => this.onFileRemoved(p))
        .on("error", (err: unknown) => this.log(`watcher error: ${(err as Error).message}`));
    }

    if (this.coworkDir) {
      this.coworkWatcher = chokidar
        .watch(this.coworkDir, {
          ignored: (p: string) => p.endsWith(".tmp") || p.includes("/.DS_Store"),
          persistent: true,
          ignoreInitial: true,
          depth: 10,
        })
        .on("add", (p: string) => this.onFileChange(p, "cowork", "add"))
        .on("change", (p: string) => this.onFileChange(p, "cowork", "change"))
        .on("error", (err: unknown) => this.log(`cowork watch error: ${(err as Error).message}`));
    }

    if (this.historyFile) {
      this.historyWatcher = chokidar
        .watch(this.historyFile, {
          persistent: true,
          ignoreInitial: true,
        })
        .on("add", () => this.readHistoryDelta())
        .on("change", () => this.readHistoryDelta())
        .on("error", (err: unknown) => this.log(`history watch error: ${(err as Error).message}`));
    }

    // 1s tick for status recompute (handles idle / awaiting-user transitions)
    setInterval(() => this.registry.recomputeAll(), 1000).unref();

    // 15s tick: low-frequency safety net. Primary change-detection is the
    // per-file fs.watch attached in onFileChange — this poll only runs to
    // (a) re-attach watchers that died from file rotation, and (b) catch
    // anything both chokidar and fs.watch somehow missed. Cheap: one stat
    // per tracked file, no extra reads unless something actually changed.
    this.pollTimer = setInterval(() => this.reconcileTrackedFiles(), 15_000);
    this.pollTimer.unref?.();

    // 30s tick: scan watched directories for NEW *.jsonl files chokidar's
    // `add` event might have missed. Even lower frequency because directory
    // walks are heavier than per-file stats.
    this.rescanTimer = setInterval(() => this.rescanWatchedDirs(), 30_000);
    this.rescanTimer.unref?.();

    // If we found absolutely nothing, surface that clearly to the operator.
    if (!this.claudeDir && !this.coworkDir) {
      this.skipStartup("no Claude or Cowork data found in any candidate location");
    }
  }

  protected async onStop(): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.rescanTimer) { clearInterval(this.rescanTimer); this.rescanTimer = null; }
    // Close per-file native watchers
    for (const entry of this.files.values()) this.detachFileWatcher(entry);
    await this.projectWatcher?.close();
    await this.coworkWatcher?.close();
    await this.historyWatcher?.close();
  }

  /**
   * Safety-net reconciliation. For every tracked file:
   *   1. Re-attach a per-file fs.watch if it died (rotation, fs glitch).
   *   2. Stat the file and re-read if size/inode has drifted past our
   *      cached TailState (catches anything chokidar AND fs.watch missed).
   * Runs every 15s — most cycles do nothing because fs.watch already fired.
   */
  private async reconcileTrackedFiles(): Promise<void> {
    if (this.files.size === 0) return;
    // Snapshot entries up front because onFileChange may mutate this.files.
    const entries = Array.from(this.files.values());
    for (const entry of entries) {
      // Re-attach watcher if it died.
      if (!entry.fileWatcher) this.ensureFileWatcher(entry);

      if (entry.pending || entry.queued) continue;
      if (!entry.state) continue; // not yet initially-consumed; chokidar add will handle it
      let st: import("node:fs").Stats | null = null;
      try {
        st = (await fs.stat(entry.filePath)) as any;
      } catch {
        // File vanished — chokidar's unlink handler will clean up; skip.
        continue;
      }
      if (!st) continue;
      const rotated = st.ino !== entry.state.inode;
      const grew = st.size > entry.state.offset;
      const shrank = st.size < entry.state.offset;
      if (rotated || grew || shrank) {
        // Reuse the normal change pipeline so dedupe / queueing still apply.
        this.onFileChange(entry.filePath, entry.source, "poll").catch((err) => {
          this.log(`[watcher poll] ${entry.filePath}: ${(err as Error).message}`);
        });
      }
    }
  }

  /**
   * Walk the watched roots for any *.jsonl files we don't already have in
   * `this.files`. Catches `add` events chokidar misses.
   */
  private async rescanWatchedDirs(): Promise<void> {
    const roots: Array<[string, "claude-code" | "cowork"]> = [];
    if (this.claudeDir) roots.push([this.claudeDir, "claude-code"]);
    if (this.coworkDir) roots.push([this.coworkDir, "cowork"]);
    for (const [root, source] of roots) {
      const found: string[] = [];
      try {
        await walk(root, found);
      } catch {
        continue;
      }
      for (const file of found) {
        if (!file.endsWith(".jsonl")) continue;
        if (this.files.has(file)) continue;
        // New file we missed — feed it through the normal pipeline.
        this.onFileChange(file, source, "rescan").catch((err) => {
          this.log(`[watcher rescan] ${file}: ${(err as Error).message}`);
        });
      }
    }
  }


  private async initialScan(root: string, source: "claude-code" | "cowork"): Promise<void> {
    const found: string[] = [];
    await walk(root, found);
    for (const file of found) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        await this.onFileChange(file, source, "initial");
      } catch (err) {
        this.log(`[watcher initial] ${file}: ${(err as Error).message}`);
      }
    }
  }

  private async primeHistory(): Promise<void> {
    if (!this.historyFile) return;
    try {
      const { state, lines } = await readEntireFile(this.historyFile);
      this.historyState = state;
      for (const line of lines) this.consumeHistoryLine(line);
    } catch {
      // history file may not exist on a fresh machine
      this.historyState = null;
    }
  }

  private async readHistoryDelta(): Promise<void> {
    if (!this.historyFile) return;
    if (!this.historyState) {
      await this.primeHistory();
      return;
    }
    try {
      const { newState, lines, rotated } = await readDelta(this.historyFile, this.historyState);
      this.historyState = newState;
      const toConsume = rotated ? lines : lines;
      for (const line of toConsume) this.consumeHistoryLine(line);
    } catch (err) {
      this.log(`history readDelta failed: ${(err as Error).message}`);
    }
  }

  private consumeHistoryLine(line: string): void {
    if (!line) return;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    if (typeof raw.display !== "string" || typeof raw.timestamp !== "number") return;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
    const project = typeof raw.project === "string" ? raw.project : null;
    if (!sessionId || !project) return;
    // Skip slash commands as user-message-equivalents
    const display = raw.display.trim();
    if (display.startsWith("/")) return;
    const preview = display.length > 120 ? display.slice(0, 117) + "…" : display;
    this.registry.setUserMessageFromHistory(project, sessionId, raw.timestamp, preview);
  }

  private async onFileChange(filePath: string, source: "claude-code" | "cowork", reason: string): Promise<void> {
    if (!filePath.endsWith(".jsonl")) return;
    if (this.shouldExclude(filePath)) return;

    const sessionId = path.basename(filePath, ".jsonl");
    if (!isUuid(sessionId)) return;

    // Determine project info.
    const projectInfo = this.projectInfoForFile(filePath, source);
    if (this.excludePathPrefixes.some((p) => projectInfo.projectPath.startsWith(p))) return;

    const isSubagent = filePath.includes("/subagents/");
    const parentSessionId = isSubagent ? extractParentSessionId(filePath) : undefined;

    this.registry.upsertMeta(sessionId, {
      filePath,
      projectPath: projectInfo.projectPath,
      projectLabel: projectInfo.projectLabel,
      source,
      isSubagent,
      parentSessionId,
    });

    let entry = this.files.get(filePath);
    if (!entry) {
      entry = {
        filePath,
        sessionId,
        source,
        projectPath: projectInfo.projectPath,
        projectLabel: projectInfo.projectLabel,
        isSubagent,
        parentSessionId,
        state: null,
        pending: false,
        queued: false,
        fileWatcher: null,
      };
      this.files.set(filePath, entry);
    }

    // Attach a per-file native watcher if we don't have one yet. This is the
    // primary mechanism for detecting appends — much more reliable than
    // chokidar's directory-level events on macOS deep trees.
    this.ensureFileWatcher(entry);

    if (entry.pending) {
      entry.queued = true;
      return;
    }
    entry.pending = true;

    try {
      do {
        entry.queued = false;
        await this.consumeFile(entry, reason === "initial");
      } while (entry.queued);
    } finally {
      entry.pending = false;
    }
  }

  /**
   * Fast backfill: read only the last 200 lines of the JSONL file instead of
   * the whole file. This makes opening a session instant regardless of file size.
   * The ring buffer holds 800 events so 200 raw lines gives plenty of headroom
   * for multi-event lines and filtered-out metadata.
   */
  async backfillSession(sessionId: string): Promise<void> {
    let filePath: string | undefined;
    for (const [fp, entry] of this.files) {
      if (entry.sessionId === sessionId) { filePath = fp; break; }
    }
    if (!filePath) return;
    const fileEntry = this.files.get(filePath);
    if (!fileEntry) return;
    try {
      const { lines, state } = await readTailLines(filePath, 200);
      // Update the tail state so subsequent readDelta calls are correct.
      fileEntry.state = state;
      for (const line of lines) this.dispatchLine(fileEntry.sessionId, line);
    } catch (err) {
      this.log(`[watcher backfill] ${filePath}: ${(err as Error).message}`);
    }
  }

  private async consumeFile(entry: FileEntry, initial: boolean): Promise<void> {
    if (entry.state === null) {
      try {
        if (initial) {
          // Metadata-only scan: just enough lines to derive status + title.
          // Avoids loading megabytes from old sessions on startup.
          const { headLines, tailLines, state } = await readHeadTail(entry.filePath, 20, 40);
          entry.state = state;
          // Parse head for title / metadata (no events buffered unless subscribed)
          for (const line of headLines) this.dispatchLine(entry.sessionId, line, true);
          // Parse tail for status derivation
          for (const line of tailLines) this.dispatchLine(entry.sessionId, line, true);
        } else {
          const { state, lines } = await readEntireFile(entry.filePath);
          entry.state = state;
          for (const line of lines) this.dispatchLine(entry.sessionId, line);
        }
      } catch (err) {
        this.log(`[watcher] failed to read ${entry.filePath}: ${(err as Error).message}`);
      }
      return;
    }
    try {
      const { newState, lines } = await readDelta(entry.filePath, entry.state);
      entry.state = newState;
      for (const line of lines) this.dispatchLine(entry.sessionId, line);
    } catch (err) {
      this.log(`[watcher] failed to tail ${entry.filePath}: ${(err as Error).message}`);
    }
  }

  private dispatchLine(sessionId: string, line: string, metaOnly = false): void {
    // Always check for title metadata lines.
    const titlePatch = parseTitleLine(line);
    if (titlePatch) {
      this.registry.setTitle(sessionId, titlePatch);
      return; // title lines are metadata only, not events
    }

    const events = parseLineMulti(line, sessionId, {
      storeImage: (buf, mediaType) => attachmentStore.put(buf, mediaType),
    });
    for (const ev of events) {
      // Capture cwd / git branch from raw line for richer metadata.
      try {
        const raw = JSON.parse(line);
        if (typeof raw?.cwd === "string" && raw.cwd.length > 0) {
          const meta = this.registry.get(sessionId);
          const fileEntry = Array.from(this.files.values()).find((e) => e.sessionId === sessionId);
          if (meta && meta.projectPath !== raw.cwd) {
            const label = labelFromPath(raw.cwd);
            this.registry.upsertMeta(sessionId, {
              filePath: fileEntry?.filePath ?? "",
              projectPath: raw.cwd,
              projectLabel: label,
              source: meta.source,
              isSubagent: meta.isSubagent,
              parentSessionId: meta.parentSessionId,
              gitBranch: typeof raw.gitBranch === "string" ? raw.gitBranch : undefined,
            });
          } else if (meta && typeof raw.gitBranch === "string" && meta.gitBranch !== raw.gitBranch) {
            this.registry.upsertMeta(sessionId, {
              filePath: fileEntry?.filePath ?? meta.projectPath,
              projectPath: meta.projectPath,
              projectLabel: meta.projectLabel,
              source: meta.source,
              isSubagent: meta.isSubagent,
              parentSessionId: meta.parentSessionId,
              gitBranch: raw.gitBranch,
            });
          }
        }
      } catch {}
      // appendEvent is a no-op for unsubscribed sessions (no event buffering).
      this.registry.appendEvent(sessionId, ev);
    }
  }

  private onFileRemoved(filePath: string): void {
    const entry = this.files.get(filePath);
    if (!entry) return;
    this.detachFileWatcher(entry);
    this.files.delete(filePath);
    this.registry.remove(entry.sessionId);
  }

  /**
   * Open a native fs.watch on this file if we don't have one yet. Idempotent.
   * On macOS this uses kqueue under the hood, which detects appends more
   * reliably than fsevents (which chokidar uses). We listen for both
   * 'change' (content modified) and 'rename' (file moved/replaced); rename
   * usually means the file was rotated, in which case we let the periodic
   * reconcile re-establish the watcher against the new inode.
   */
  private ensureFileWatcher(entry: FileEntry): void {
    if (entry.fileWatcher) return;
    let watcher: NativeFSWatcher;
    try {
      // persistent:false so a stale watcher can't keep the event loop alive
      // independently of the main HTTP server.
      watcher = fsWatch(entry.filePath, { persistent: false });
    } catch (err) {
      // fs.watch can fail on some filesystems (network mounts, etc.) — the
      // polling reconcile loop is our fallback.
      this.log(`[fs.watch] failed to attach ${entry.filePath}: ${(err as Error).message}`);
      return;
    }
    watcher.on("change", () => {
      this.onFileChange(entry.filePath, entry.source, "fs-watch").catch((err) => {
        this.log(`[fs.watch change] ${entry.filePath}: ${(err as Error).message}`);
      });
    });
    watcher.on("error", () => {
      // Watcher died (file rotated, fs glitch, etc.) — drop it and let
      // reconcileTrackedFiles re-attach on the next tick if the file still exists.
      try { watcher.close(); } catch {}
      if (entry.fileWatcher === watcher) entry.fileWatcher = null;
    });
    watcher.on("close", () => {
      if (entry.fileWatcher === watcher) entry.fileWatcher = null;
    });
    entry.fileWatcher = watcher;
  }

  private detachFileWatcher(entry: FileEntry): void {
    if (!entry.fileWatcher) return;
    try { entry.fileWatcher.close(); } catch {}
    entry.fileWatcher = null;
  }

  private projectInfoForFile(filePath: string, source: "claude-code" | "cowork"): { projectPath: string; projectLabel: string } {
    if (source === "claude-code") {
      // Decode the encoded project segment relative to the discovered Claude
      // projects dir (or the default constant when discovery hasn't run yet).
      const root = this.claudeDir ?? CLAUDE_PROJECTS_DIR;
      const rel = path.relative(root, filePath);
      const encoded = rel.split(path.sep)[0];
      if (this.projectByPath.has(encoded)) return this.projectByPath.get(encoded)!;
      const info = decodeProjectDir(encoded);
      this.projectByPath.set(encoded, info);
      return info;
    }
    // Cowork: path is e.g. <coworkDir>/<install-id>/<install-id>/local_<id>/<uuid>.jsonl
    // Use the deepest folder name as label.
    const dir = path.dirname(filePath);
    const folder = path.basename(dir);
    return { projectPath: dir, projectLabel: `cowork / ${folder}` };
  }

  private shouldExclude(filePath: string): boolean {
    if (this.excludePathPrefixes.length === 0) return false;
    return this.excludePathPrefixes.some((p) => filePath.startsWith(p));
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function extractParentSessionId(filePath: string): string | undefined {
  // .../<parentUuid>/subagents/agent-<uuid>.jsonl (heuristic)
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf("subagents");
  if (idx > 0) {
    const candidate = parts[idx - 1];
    if (isUuid(candidate)) return candidate;
  }
  return undefined;
}

function labelFromPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  if (segs.length >= 2) return `${segs[segs.length - 2]} / ${segs[segs.length - 1]}`;
  return segs[segs.length - 1] ?? p;
}

async function stat(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function walk(root: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })) as any;
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, String(entry.name));
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}
