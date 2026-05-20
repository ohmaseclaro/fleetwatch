#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadEnv, envFlag, envString } from "./env.js";
// Load .env BEFORE any other module reads process.env.
loadEnv();
import { SessionRegistry } from "./registry.js";
import { Watcher } from "./watcher.js";
import { ProviderManager } from "./providers/types.js";
import { CursorProvider } from "./providers/cursor.js";
import { loadOrInitConfig, buildPairingPayload, pickLanIp, saveConfig } from "./pairing.js";
import { startServer } from "./server.js";
import { startTunnel, stopTunnel, activeTunnel } from "./tunnel.js";
import { initAuth, isPasswordRequired } from "./auth.js";
import { findNgrokAuthtoken } from "./ngrokConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the package version at runtime so it's always in sync with
 * package.json — no more hard-coded version drift between npm releases
 * and the CLI banner / `--help` output.
 */
function readPackageVersion(): string {
  // Look upward from dist/server for the nearest package.json. When run from
  // an installed location (node_modules/@scope/pkg/dist/server/index.js) this
  // finds the package's own manifest.
  for (const candidate of [
    path.join(__dirname, "..", "..", "package.json"),  // dist/server → pkg root
    path.join(__dirname, "..", "package.json"),        // when bundled differently
  ]) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {}
  }
  // Last-resort fallback: createRequire so users running via tsx still work.
  try {
    const req = createRequire(import.meta.url);
    return (req("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

const AGENT_VERSION = readPackageVersion();

interface Args {
  port: number;
  host: string;
  includeCowork?: boolean;
  quiet: boolean;
  ngrokAuthtoken?: string;
  /** `--no-ngrok` — disable ngrok for THIS run only (ephemeral). */
  ngrokDisabled?: boolean;
  /** `--ngrok` — force-enable ngrok for this run, overriding any persisted disable. */
  ngrokForceOn?: boolean;
  /** `--reset-ngrok` — clear the persisted disabled flag so ngrok stays on across runs. */
  ngrokReset?: boolean;
  cursorDisabled?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: parseInt(process.env.PORT ?? "7878", 10),
    host: process.env.HOST ?? "0.0.0.0",
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") args.port = parseInt(argv[++i] ?? "7878", 10);
    else if (a === "--host") args.host = argv[++i] ?? "0.0.0.0";
    else if (a === "--include-cowork") args.includeCowork = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--ngrok-authtoken") args.ngrokAuthtoken = argv[++i];
    else if (a === "--no-ngrok") args.ngrokDisabled = true;
    else if (a === "--ngrok") args.ngrokForceOn = true;
    else if (a === "--reset-ngrok") args.ngrokReset = true;
    else if (a === "--no-cursor") args.cursorDisabled = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`fleetwatch v${AGENT_VERSION}

Usage: fleetwatch [options]

Options:
  --port, -p <port>       Port to listen on (default 7878)
  --host <host>           Bind address (default 0.0.0.0 — your LAN)
  --include-cowork        Also surface Cowork desktop sessions
  --quiet, -q             Suppress QR / banner output
  --ngrok-authtoken <t>   ngrok authtoken for auto-started HTTPS tunnel (free tier OK)
  --no-ngrok              Disable the ngrok tunnel for THIS run (ephemeral)
  --ngrok                 Force-enable ngrok for this run, overriding stored config
  --reset-ngrok           Clear the persisted "ngrok disabled" flag so it stays on
  --no-cursor             Skip the Cursor IDE provider (Claude only)
  --help, -h              Show this help

Environment / .env (reads ./.env then ~/.config/fleetwatch/.env):
  NGROK_AUTHTOKEN         ngrok free-tier authtoken (required for tunnel)
  NGROK_DISABLED=1        Disable ngrok tunnel
  CURSOR_DISABLED=1       Disable Cursor IDE provider
  PASSWORD                Optional password (bcrypt-hashed in memory only)
  JWT_SECRET              Optional JWT signing secret (auto-generated otherwise)

The daemon serves a mobile-friendly web UI. ngrok is enabled by default so
you can reach it from anywhere; set NGROK_AUTHTOKEN once (free at
https://dashboard.ngrok.com/get-started/your-authtoken) or use --no-ngrok
to stay LAN-only.`);
}

type TokenSource = "cli" | "env" | "config" | "ngrok-config";

interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** For "ngrok-config" — the file path it came from, for the banner. */
  sourcePath?: string;
}

/**
 * Resolve the ngrok authtoken in priority order:
 *   1. CLI `--ngrok-authtoken`
 *   2. env `NGROK_AUTHTOKEN`
 *   3. fleetwatch's own config (Settings UI / past CLI saves)
 *   4. ngrok's own config file (~/Library/Application Support/ngrok/ngrok.yml)
 *      — so users who've run `ngrok config add-authtoken` get it for free.
 *
 * Returns null when no token is reachable anywhere.
 */
function resolveNgrokAuthtoken(
  args: Args,
  config: { ngrokAuthtoken?: string },
): ResolvedToken | null {
  if (args.ngrokAuthtoken) return { token: args.ngrokAuthtoken, source: "cli" };
  const envToken = envString("NGROK_AUTHTOKEN");
  if (envToken) return { token: envToken, source: "env" };
  if (config.ngrokAuthtoken) return { token: config.ngrokAuthtoken, source: "config" };
  const fromNgrok = findNgrokAuthtoken();
  if (fromNgrok) return { token: fromNgrok.authtoken, source: "ngrok-config", sourcePath: fromNgrok.source };
  return null;
}

type DisableSource = "cli" | "env" | "config" | null;

/**
 * Decide whether ngrok is disabled and report which source disabled it.
 * Precedence: --ngrok force-on > CLI --no-ngrok > env NGROK_DISABLED > config.
 * Returning `null` means ngrok is enabled.
 */
function resolveNgrokDisabled(args: Args, config: { ngrokDisabled?: boolean }): DisableSource {
  if (args.ngrokForceOn) return null;          // explicit override wins
  if (args.ngrokDisabled) return "cli";
  if (envFlag("NGROK_DISABLED")) return "env";
  if (config.ngrokDisabled) return "config";
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadOrInitConfig();
  if (args.includeCowork !== undefined) {
    config.preferences.includeCowork = args.includeCowork;
    await saveConfig(config);
  }
  // CLI-supplied authtoken IS persisted (one-time setup convenience).
  if (args.ngrokAuthtoken) {
    config.ngrokAuthtoken = args.ngrokAuthtoken;
    // Setting an authtoken implies you want ngrok on — clear any stale disable.
    config.ngrokDisabled = undefined;
    await saveConfig(config);
  }
  // `--reset-ngrok` or `--ngrok`: clear the persisted disabled flag so the
  // user recovers from a stuck state without editing config.json by hand.
  if (args.ngrokReset || args.ngrokForceOn) {
    if (config.ngrokDisabled) {
      config.ngrokDisabled = undefined;
      await saveConfig(config);
    }
  }
  // NOTE: `--no-ngrok` is intentionally NOT persisted to config. It's an
  // ephemeral, single-run override. Persistent disable should be set via
  // the Settings UI or NGROK_DISABLED=1 env var.

  // --- Initialize auth: optional password (from env) + JWT signing ---
  initAuth({
    password: envString("PASSWORD"),
    jwtSecret: envString("JWT_SECRET") ?? config.jwtSecret,
    pairingToken: config.token,
  });

  const log = (msg: string) => { if (!args.quiet) console.error(msg); };

  const registry = new SessionRegistry();
  registry.setMaxListeners(64);

  // --- Providers: assemble all data sources behind a single manager ---
  const providers = new ProviderManager();
  providers.add(new Watcher({ registry, onLog: log }));

  const cursorDisabled = args.cursorDisabled || envFlag("CURSOR_DISABLED");
  if (!cursorDisabled) {
    try {
      providers.add(new CursorProvider({ registry, onLog: log }));
    } catch (err) {
      log(`[cursor] disabled: ${(err as Error).message}`);
    }
  } else {
    log(`[cursor] disabled (--no-cursor or CURSOR_DISABLED=1)`);
  }

  // Locate web bundle.
  const candidates = [
    path.join(__dirname, "..", "web"), // dist/server/index.js -> dist/web
    path.join(__dirname, "..", "..", "dist", "web"),
    path.join(process.cwd(), "dist", "web"),
  ];
  const webRoot = candidates.find((p) => existsSync(p)) ?? candidates[0];

  await providers.startAll();

  /** (Re)start the ngrok tunnel; called at boot and when the token changes. */
  async function restartTunnel(authtoken: string): Promise<void> {
    await startTunnel({ port: args.port, authtoken, onLog: log });
  }

  const fastify = await startServer({
    port: args.port,
    host: args.host,
    config,
    registry,
    providers,
    webRoot,
    agentVersion: AGENT_VERSION,
    onLog: log,
    onConfigChanged: (_cfg) => {},
    onTunnelAuthtoken: async (authtoken) => {
      config.ngrokAuthtoken = authtoken;
      await restartTunnel(authtoken);
    },
  });

  // --- Start the ngrok tunnel (non-blocking; QR is printed first with LAN URL,
  //     then re-printed once the tunnel URL is known). ---
  const resolved = resolveNgrokAuthtoken(args, config);
  const ngrokToken = resolved?.token;
  const disableSource = resolveNgrokDisabled(args, config);
  const ngrokDisabled = disableSource !== null;
  const passwordOn = isPasswordRequired();

  const printBanner = async () => {
    if (args.quiet) return;
    const lan = pickLanIp() ?? "127.0.0.1";
    const tunnel = activeTunnel();
    const payload = await buildPairingPayload(lan, args.port, config.token, tunnel?.url);
    const url = payload.url;

    console.log("");
    console.log("  \x1b[1m\x1b[38;5;208mfleetwatch\x1b[0m  v" + AGENT_VERSION);
    console.log("  ─────────────────────────────────────────");
    console.log("");
    if (tunnel) {
      console.log("  Open this on your phone \x1b[32m(works anywhere — via ngrok)\x1b[0m:");
    } else {
      console.log("  Open this on your phone (same Wi-Fi):");
    }
    console.log("");
    console.log(`     \x1b[1m\x1b[38;5;208m${url}\x1b[0m`);
    console.log("");
    console.log("  Or scan the QR code below:");
    console.log("");
    process.stdout.write(payload.qrAscii);
    console.log("");
    console.log(`  Host:    ${config.hostLabel}`);
    console.log(`  Port:    ${args.port}`);
    if (tunnel) {
      const src = tokenSourceLabel(resolved);
      console.log(`  Tunnel:  \x1b[32m${tunnel.url}\x1b[0m${src ? `   \x1b[90m(${src})\x1b[0m` : ""}`);
    } else if (disableSource === "cli") {
      console.log(`  Tunnel:  \x1b[90mdisabled\x1b[0m (--no-ngrok)`);
    } else if (disableSource === "env") {
      console.log(`  Tunnel:  \x1b[90mdisabled\x1b[0m (NGROK_DISABLED=1 in env)`);
    } else if (disableSource === "config") {
      console.log(`  Tunnel:  \x1b[33mdisabled by stored config\x1b[0m`);
      console.log(`           Run with \x1b[1m--reset-ngrok\x1b[0m to clear, or toggle in Settings.`);
    } else if (ngrokToken) {
      const src = tokenSourceLabel(resolved);
      console.log(`  Tunnel:  connecting…${src ? `   \x1b[90m(${src})\x1b[0m` : ""}`);
    } else {
      console.log(`  Tunnel:  \x1b[33mnot configured\x1b[0m (LAN-only — same Wi-Fi required)`);
    }
    console.log(`  Auth:    ${passwordOn ? "\x1b[32mpassword required\x1b[0m" : "\x1b[33mpairing token only\x1b[0m (set PASSWORD to add a password)"}`);
    console.log(`  Cowork:  ${config.preferences.includeCowork ? "on" : "off"} (toggle in Settings)`);
    console.log("");

    // Onboarding panel — only shown when ngrok isn't set up yet.
    if (!tunnel && !ngrokDisabled && !ngrokToken) {
      printNgrokSetupHelp(args.port);
    }
    console.log("  Press Ctrl+C to stop.");
    console.log("");
  };

  // Print initial banner immediately with LAN URL.
  await printBanner();

  // Then start ngrok in background; re-print banner when ready.
  if (ngrokToken && !ngrokDisabled) {
    restartTunnel(ngrokToken).then(() => {
      if (activeTunnel()) {
        // Clear last N lines and reprint (simple approach: just print again).
        console.log("  \x1b[33m↻ ngrok tunnel ready — updated QR:\x1b[0m");
        printBanner();
      }
    });
  }

  const shutdown = async () => {
    console.log("\nShutting down…");
    await stopTunnel().catch(() => {});
    await providers.stopAll();
    await fastify.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Short human label for where the ngrok authtoken came from, shown in the
 * banner so users understand why a tunnel is/isn't starting.
 */
function tokenSourceLabel(r: ResolvedToken | null): string {
  if (!r) return "";
  switch (r.source) {
    case "cli": return "token via --ngrok-authtoken";
    case "env": return "token via NGROK_AUTHTOKEN env";
    case "config": return "token via stored config";
    case "ngrok-config":
      return r.sourcePath
        ? `token via ngrok.yml (${shortenHome(r.sourcePath)})`
        : "token via ngrok.yml";
  }
}

function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * Print a friendly onboarding panel for first-time ngrok setup.
 * Uses OSC-8 terminal hyperlinks where supported (iTerm2, modern terminals)
 * — degrades to plain text in older terminals.
 */
function printNgrokSetupHelp(port: number): void {
  const link = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

  console.log(`  ${yellow("┌──────── Make this reachable from anywhere ────────┐")}`);
  console.log(`  ${yellow("│")}`);
  console.log(`  ${yellow("│")}  ngrok creates a public HTTPS URL so your phone`);
  console.log(`  ${yellow("│")}  works on cellular, coffee shops, anywhere.`);
  console.log(`  ${yellow("│")}  ${dim("(Free tier, no credit card required.)")}`);
  console.log(`  ${yellow("│")}`);
  console.log(`  ${yellow("│")}  ${bold("1.")} Sign up:`);
  console.log(`  ${yellow("│")}     ${link("https://dashboard.ngrok.com/signup", "https://dashboard.ngrok.com/signup")}`);
  console.log(`  ${yellow("│")}`);
  console.log(`  ${yellow("│")}  ${bold("2.")} Copy your authtoken:`);
  console.log(`  ${yellow("│")}     ${link("https://dashboard.ngrok.com/get-started/your-authtoken", "https://dashboard.ngrok.com/get-started/your-authtoken")}`);
  console.log(`  ${yellow("│")}`);
  console.log(`  ${yellow("│")}  ${bold("3.")} Restart with the token:`);
  console.log(`  ${yellow("│")}     ${bold("fleetwatch --ngrok-authtoken <your-token>")}`);
  console.log(`  ${yellow("│")}     ${dim("or set NGROK_AUTHTOKEN=... in .env")}`);
  console.log(`  ${yellow("│")}     ${dim("or paste it in Settings once paired locally")}`);
  console.log(`  ${yellow("│")}`);
  console.log(`  ${yellow("└────────────────────────────────────────────────────┘")}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
