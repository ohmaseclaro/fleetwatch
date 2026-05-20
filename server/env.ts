/**
 * Load .env files. Priority (first match per key wins — dotenv's
 * "don't clobber existing" semantics):
 *
 *   1. process.env (already set in shell)
 *   2. ./.env in current working directory
 *   3. ~/.config/fleetwatch/.env
 *   4. ~/.config/claude-watcher/.env (legacy from the rename — auto-picked up)
 *
 * Shell env > project .env > user-global .env. Ship defaults in your global
 * file and override per-project.
 */
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const cwdEnv = path.join(process.cwd(), ".env");
  const globalEnv = path.join(os.homedir(), ".config", "fleetwatch", ".env");
  const legacyGlobalEnv = path.join(os.homedir(), ".config", "claude-watcher", ".env");

  // dotenv.config({ override: false }) → don't overwrite already-set vars
  if (existsSync(cwdEnv)) dotenv.config({ path: cwdEnv, override: false });
  if (existsSync(globalEnv)) dotenv.config({ path: globalEnv, override: false });
  if (existsSync(legacyGlobalEnv)) dotenv.config({ path: legacyGlobalEnv, override: false });
}

export function envFlag(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function envString(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}
