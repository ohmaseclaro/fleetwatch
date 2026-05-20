/**
 * Provider data-location discovery.
 *
 * Every provider declares a `DiscoverySpec` describing where its data MIGHT
 * live, and the abstraction handles the rest:
 *
 *   1. Try each `candidates[]` path in order. If exists AND `verify()`
 *      confirms it's our data, return it.
 *   2. If no candidate matched, optionally do a bounded filesystem search
 *      under `searchRoots[]` looking for `searchFilename` matches. Every
 *      match still has to pass `verify()`.
 *   3. Return null if nothing was found — the provider should call
 *      `skipStartup(...)` and exit gracefully.
 *
 * The mandatory `verify()` predicate is what keeps us from mistaking one
 * provider's data for another's: VSCode and Cursor both have a `state.vscdb`,
 * but only Cursor's contains a `cursorDiskKV` table. Claude Code and Cowork
 * both use JSONL, but live in distinctively-named parent directories.
 *
 * Search is intentionally bounded (depth-capped, common heavy dirs ignored)
 * so that probing a misconfigured machine doesn't cost the user 30 seconds
 * of `find /`. Default depth is 6 — enough to reach `~/Library/Application
 * Support/<App>/User/globalStorage/state.vscdb` but not enough to walk a
 * monorepo's node_modules.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export interface DiscoverySpec {
  /**
   * Short human label for log messages, e.g. "Claude projects dir".
   */
  label: string;
  /**
   * Ordered candidate paths to try first. Earlier entries win.
   * Falsy / null / empty-string entries are silently dropped so callers can
   * splice in optional paths cleanly (e.g. only Windows-only paths on Win32).
   */
  candidates: Array<string | null | undefined | false>;
  /**
   * Optional: roots to scan recursively if no candidate matched. Each root
   * must already exist on disk — non-existent roots are skipped.
   */
  searchRoots?: string[];
  /**
   * Filename (or directory name) to look for during search. Compared against
   * each entry's `basename`. Provide a RegExp for more flexibility.
   */
  searchName?: string | RegExp;
  /**
   * Optional additional filter: a candidate path is only considered if it
   * contains this substring. Used to keep Cursor's `state.vscdb` search from
   * matching VSCode's, etc.
   */
  pathMustContain?: string;
  /**
   * Maximum directory depth to recurse during search. Default 6.
   */
  searchMaxDepth?: number;
  /**
   * Mandatory disambiguator: given a candidate path that exists, return true
   * iff it's actually our provider's data. Should be cheap (a few syscalls,
   * a single small read) — it gets called on every candidate AND every
   * search hit.
   */
  verify(candidatePath: string): Promise<boolean>;
}

export type DiscoveryLogger = (msg: string) => void;

/**
 * Common large/uninteresting directories we never recurse into during search.
 * Keeps `find`-style scans fast and avoids reading user-content trees.
 */
const IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  "Caches",
  "Trash",
  ".Trash",
  "iCloud~",
  "target",
  "build",
  "out",
  "dist",
  ".npm",
  ".nvm",
  ".pnpm",
  ".pyenv",
  ".rbenv",
  "venv",
  ".venv",
  "__pycache__",
  // macOS — avoid scanning huge user-content libraries
  "Photos Library.photoslibrary",
  "Music",
  "Movies",
  "Pictures",
  "Downloads",
  // Common backup tools
  "Backups.backupdb",
]);

/**
 * Locate the data path for a provider using its DiscoverySpec.
 * Returns the resolved path or null if nothing matched.
 */
export async function discover(
  spec: DiscoverySpec,
  log: DiscoveryLogger = () => {},
): Promise<string | null> {
  // 1) Walk the explicit candidate list — fastest path, no I/O beyond stat.
  for (const raw of spec.candidates) {
    if (!raw) continue;
    if (!existsSync(raw)) continue;
    try {
      if (await spec.verify(raw)) {
        log(`discovery: found ${spec.label} at ${raw}`);
        return raw;
      }
    } catch {
      // verifier threw — treat as "not us" and keep going
    }
  }

  // 2) Fall back to a bounded filesystem search.
  if (!spec.searchName || !spec.searchRoots || spec.searchRoots.length === 0) {
    log(`discovery: no candidates matched for ${spec.label}; no search roots configured`);
    return null;
  }

  const maxDepth = spec.searchMaxDepth ?? 6;
  const matches: string[] = [];
  for (const root of spec.searchRoots) {
    if (!existsSync(root)) continue;
    await scan(root, spec.searchName, maxDepth, 0, matches);
  }
  if (matches.length === 0) {
    log(`discovery: search found no ${spec.label} candidates`);
    return null;
  }

  // 3) Apply optional pathMustContain filter then verify each hit.
  const filtered = spec.pathMustContain
    ? matches.filter((m) => m.includes(spec.pathMustContain!))
    : matches;
  for (const hit of filtered) {
    try {
      if (await spec.verify(hit)) {
        log(`discovery: found ${spec.label} via search at ${hit}`);
        return hit;
      }
    } catch {
      // skip
    }
  }
  log(`discovery: ${spec.label} candidates failed verification (tried ${filtered.length})`);
  return null;
}

/**
 * Bounded recursive directory walk. Pushes matching paths into `out`.
 * Skips IGNORE_DIRS and hidden directories below the first level.
 */
async function scan(
  dir: string,
  name: string | RegExp,
  maxDepth: number,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as any;
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    // Don't chase symlinks — they can create cycles or escape the search root.
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    // We deliberately DON'T skip hidden dirs in general — many providers
    // store data in dotted config dirs (~/.claude, ~/.config, ~/.cursor).
    // The IGNORE_DIRS set above carves out the genuinely noisy ones
    // (.git, .cache, .npm, .Trash, etc.).
    const full = path.join(dir, entry.name);
    const isMatch =
      typeof name === "string" ? entry.name === name : name.test(entry.name);
    if (isMatch) out.push(full);
    if (entry.isDirectory()) {
      await scan(full, name, maxDepth, depth + 1, out);
    }
  }
}
