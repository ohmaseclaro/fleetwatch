/**
 * Manages a single ngrok HTTPS tunnel that forwards traffic to the local
 * Fastify server. The tunnel is started once at boot and torn down on exit.
 *
 * Free tier (free.ngrok.com account, no credit card):
 *   https://dashboard.ngrok.com/get-started/your-authtoken
 */
import ngrok from "@ngrok/ngrok";

export interface TunnelInfo {
  url: string;
  stop: () => Promise<void>;
}

export interface TunnelOptions {
  port: number;
  authtoken: string;
  onLog?: (msg: string) => void;
}

export interface TunnelError {
  /** Stable code we map to user-friendly UI messages. */
  code: "invalid_authtoken" | "limited_tier" | "network" | "unknown";
  /** Raw message from the ngrok SDK. */
  raw: string;
  /** Human-readable explanation + suggested next action. */
  hint: string;
}

let active: TunnelInfo | null = null;
let lastError: TunnelError | null = null;

/**
 * Map raw ngrok error strings to a stable error code + actionable hint.
 * Free-tier errors usually include `ERR_NGROK_<code>`; we sniff for that.
 */
function classifyError(raw: string): TunnelError {
  const lower = raw.toLowerCase();
  if (lower.includes("err_ngrok_105") || lower.includes("invalid") && lower.includes("token")) {
    return {
      code: "invalid_authtoken",
      raw,
      hint: "ngrok rejected the authtoken. Double-check it at https://dashboard.ngrok.com/get-started/your-authtoken",
    };
  }
  if (lower.includes("err_ngrok_3200") || lower.includes("limit") || lower.includes("simultaneous")) {
    return {
      code: "limited_tier",
      raw,
      hint: "Free tier limit hit — only one ngrok agent can run at a time. Stop other ngrok instances first.",
    };
  }
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("etimedout") || lower.includes("network")) {
    return {
      code: "network",
      raw,
      hint: "Could not reach ngrok servers. Check your internet connection and try again.",
    };
  }
  return {
    code: "unknown",
    raw,
    hint: "Tunnel start failed. See the raw error for details — and try restarting the daemon.",
  };
}

/**
 * Start the ngrok tunnel. Returns the public HTTPS URL, or null if it fails.
 * Only one tunnel is kept alive at a time — calling again closes the old one.
 */
export async function startTunnel(opts: TunnelOptions): Promise<TunnelInfo | null> {
  // Tear down any existing tunnel first.
  if (active) {
    await active.stop().catch(() => {});
    active = null;
  }
  lastError = null;

  try {
    opts.onLog?.("[ngrok] connecting tunnel…");
    const listener = await ngrok.forward({
      addr: opts.port,
      authtoken: opts.authtoken,
      schemes: ["https"],
      // Skip the browser interstitial page on free tier.
      request_header_add: ["ngrok-skip-browser-warning: 1"],
    });

    const url = listener.url();
    if (!url) throw new Error("ngrok returned no URL");

    opts.onLog?.(`[ngrok] tunnel active: ${url}`);

    active = {
      url,
      stop: async () => {
        try { await listener.close(); } catch {}
        active = null;
      },
    };
    return active;
  } catch (err) {
    const raw = (err as Error).message;
    lastError = classifyError(raw);
    opts.onLog?.(`[ngrok] ${lastError.code}: ${lastError.hint}`);
    opts.onLog?.(`[ngrok] (raw: ${raw})`);
    return null;
  }
}

export function lastTunnelError(): TunnelError | null {
  return lastError;
}

/**
 * Stop the currently active tunnel (if any). Safe to call when not running.
 */
export async function stopTunnel(): Promise<void> {
  if (active) {
    await active.stop().catch(() => {});
    active = null;
  }
}

export function activeTunnel(): TunnelInfo | null {
  return active;
}
