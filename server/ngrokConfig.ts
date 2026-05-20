/**
 * Read the user's existing ngrok authtoken from ngrok's own config file.
 *
 * If they've already run `ngrok config add-authtoken <token>` at some point,
 * the token is sitting in ngrok.yml — no reason to make them paste it again.
 *
 * Supported locations (in order):
 *   - macOS (v3):        ~/Library/Application Support/ngrok/ngrok.yml
 *   - Linux/Win (v3):    ~/.config/ngrok/ngrok.yml  (or $LOCALAPPDATA/ngrok/)
 *   - Legacy (v2):       ~/.ngrok2/ngrok.yml
 *
 * Supported formats:
 *   v2:  `authtoken: <token>`     (top-level)
 *   v3:  `agent:\n  authtoken: <token>`  (nested under agent)
 *
 * We don't add a YAML dependency for this — a single-line regex over the file
 * is sufficient since ngrok.yml has exactly one `authtoken:` key.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface NgrokConfigResult {
  authtoken: string;
  /** Absolute path of the file we found it in — useful for the startup banner. */
  source: string;
}

/** Default locations to probe, in priority order. */
function candidatePaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];

  if (process.platform === "darwin") {
    paths.push(path.join(home, "Library", "Application Support", "ngrok", "ngrok.yml"));
  }
  // Linux + common cross-platform location
  paths.push(path.join(home, ".config", "ngrok", "ngrok.yml"));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    paths.push(path.join(process.env.LOCALAPPDATA, "ngrok", "ngrok.yml"));
  }
  // Legacy v2 location
  paths.push(path.join(home, ".ngrok2", "ngrok.yml"));
  return paths;
}

/**
 * Probe known ngrok config paths and return the first authtoken found.
 * Returns null if no ngrok config file exists or none contain an authtoken.
 */
export function findNgrokAuthtoken(): NgrokConfigResult | null {
  for (const p of candidatePaths()) {
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const token = parseAuthtoken(raw);
    if (token) return { authtoken: token, source: p };
  }
  return null;
}

/**
 * Extract the authtoken value from a ngrok.yml file's contents.
 *
 * Handles both v2 (top-level `authtoken:`) and v3 (`agent: authtoken:` nested
 * with 2-space indent). Strips optional surrounding quotes. Skips commented
 * lines.
 */
export function parseAuthtoken(yaml: string): string | null {
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Match `authtoken: value`  (optionally quoted, any indentation)
    const m = trimmed.match(/^authtoken:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/);
    if (m && m[1]) return m[1];
  }
  return null;
}
