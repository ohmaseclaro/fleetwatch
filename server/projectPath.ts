/**
 * Claude Code stores sessions under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 * where <encoded-cwd> is the absolute path with '/' replaced by '-' (leading
 * '/' becomes a leading '-').
 *
 * Decoding back is ambiguous because real directory names may contain '-',
 * so we use a heuristic: walk the candidate path checking which prefix
 * actually exists on disk, and reconstruct.
 *
 * For display purposes we don't need full fidelity — the last two segments
 * are enough.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const cache = new Map<string, { projectPath: string; projectLabel: string }>();

export function decodeProjectDir(encoded: string): { projectPath: string; projectLabel: string } {
  const cached = cache.get(encoded);
  if (cached) return cached;

  // Strategy: assume the typical case is /Users/name/... — try filesystem-resolution first.
  const guessed = `/${encoded.replace(/^-/, "").split("-").join("/")}`;
  let resolved = guessed;
  if (!existsSync(guessed)) {
    // Try resolving with a smarter walk: prefer the deepest prefix that exists.
    resolved = bestExistingPath(encoded) ?? guessed;
  }

  const segments = resolved.split("/").filter(Boolean);
  const label =
    segments.length >= 2
      ? `${segments[segments.length - 2]} / ${segments[segments.length - 1]}`
      : segments[segments.length - 1] ?? encoded;

  const result = { projectPath: resolved, projectLabel: label };
  cache.set(encoded, result);
  return result;
}

function bestExistingPath(encoded: string): string | null {
  const parts = encoded.replace(/^-/, "").split("-");
  if (parts.length === 0) return null;
  // Greedy: walk parts left-to-right; at each step try joining the next
  // chunk with either "-" or "/". Prefer "/" when the candidate exists.
  let acc = `/${parts[0]}`;
  for (let i = 1; i < parts.length; i++) {
    const withSlash = `${acc}/${parts[i]}`;
    const withDash = `${acc}-${parts[i]}`;
    if (existsSync(withSlash)) {
      acc = withSlash;
    } else if (existsSync(withDash)) {
      acc = withDash;
    } else {
      // Neither prefix exists. Default to slash (typical case).
      acc = withSlash;
    }
  }
  return acc;
}
