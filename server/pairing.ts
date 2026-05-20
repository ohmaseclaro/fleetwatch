import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import QRCode from "qrcode";

/**
 * Where persisted state lives. We migrated from `~/.config/claude-watcher/`
 * to `~/.config/fleetwatch/` when the project was renamed — `loadOrInitConfig`
 * silently picks up the old location if the new one doesn't exist yet.
 */
const CONFIG_DIR = path.join(os.homedir(), ".config", "fleetwatch");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".config", "claude-watcher", "config.json");

export interface Config {
  /** Long-lived pairing token; embedded in QR URL, used to bootstrap auth. */
  token: string;
  /** Stable secret for signing JWTs (persisted so issued JWTs survive restart). */
  jwtSecret: string;
  /** Friendly name for this desktop, shown on the phone. */
  hostLabel: string;
  /**
   * ngrok authtoken for the auto-started tunnel (free tier OK).
   * Get yours at https://dashboard.ngrok.com/get-started/your-authtoken
   */
  ngrokAuthtoken?: string;
  /** If true, skip starting the ngrok tunnel even if a token is available. */
  ngrokDisabled?: boolean;
  /** User preferences */
  preferences: {
    includeCowork: boolean;
    showLibrarySessions: boolean;
  };
}

export async function loadOrInitConfig(): Promise<Config> {
  try {
    // Prefer the new location; transparently fall back to the legacy one
    // from when this project was called claude-watcher. Once we successfully
    // save back, future loads come from the new path only.
    let raw: string;
    try {
      raw = await fs.readFile(CONFIG_FILE, "utf8");
    } catch {
      if (!existsSync(LEGACY_CONFIG_FILE)) throw new Error("no config yet");
      raw = await fs.readFile(LEGACY_CONFIG_FILE, "utf8");
    }
    const parsed = JSON.parse(raw) as Partial<Config>;
    const result: Config = {
      token: parsed.token ?? nanoid(32),
      jwtSecret: parsed.jwtSecret ?? nanoid(48),
      hostLabel: parsed.hostLabel ?? os.hostname(),
      ngrokAuthtoken: parsed.ngrokAuthtoken,
      ngrokDisabled: parsed.ngrokDisabled,
      preferences: {
        includeCowork: parsed.preferences?.includeCowork ?? false,
        showLibrarySessions: parsed.preferences?.showLibrarySessions ?? false,
      },
    };
    // Persist on first read after migration / when we auto-generated fields.
    if (!parsed.jwtSecret || !existsSync(CONFIG_FILE)) await saveConfig(result);
    return result;
  } catch {
    const fresh: Config = {
      token: nanoid(32),
      jwtSecret: nanoid(48),
      hostLabel: os.hostname(),
      preferences: { includeCowork: false, showLibrarySessions: false },
    };
    await saveConfig(fresh);
    return fresh;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export async function rotateToken(cfg: Config): Promise<Config> {
  const next: Config = { ...cfg, token: nanoid(32) };
  await saveConfig(next);
  return next;
}

export interface PairingInfo {
  url: string;
  qrSvg: string;
  qrAscii: string;
}

export async function buildPairingPayload(host: string, port: number, token: string, overrideUrl?: string): Promise<PairingInfo> {
  const url = overrideUrl
    ? `${overrideUrl}/?token=${encodeURIComponent(token)}`
    : `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
  const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 320, color: { dark: "#3D3929", light: "#FAF9F5" } });
  const qrAscii = await QRCode.toString(url, { type: "terminal", small: true });
  return { url, qrSvg, qrAscii };
}

export function pickLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  let candidate: string | null = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // Prefer en0/en1 on macOS, but pick any non-internal IPv4.
      if (name.startsWith("en") || name.startsWith("wlan") || name.startsWith("eth")) {
        if (addr.address.startsWith("192.168.") || addr.address.startsWith("10.") || addr.address.startsWith("172.")) {
          return addr.address;
        }
      }
      candidate = candidate ?? addr.address;
    }
  }
  return candidate;
}
