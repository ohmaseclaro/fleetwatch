/**
 * Abstract base class for fleetwatch providers.
 *
 * A "provider" is anything that surfaces agent sessions into the shared
 * SessionRegistry: file-tailing (Claude Code JSONL), database polling
 * (Cursor SQLite), HTTP polling (future: Claude.ai chats, Aider, Continue),
 * etc.
 *
 * Adding a new provider is intentionally a small commitment — extend this
 * class, declare your `info`, implement `onStart`/`onStop`/`backfillSession`,
 * and wire it into ProviderManager in `server/index.ts`.
 *
 * See docs/ADD_A_PROVIDER.md for a step-by-step guide.
 */
import type { SessionRegistry } from "../registry.js";
import type { Provider } from "./types.js";
import type { SessionSource } from "../../shared/types.js";
import { discover, type DiscoverySpec } from "./discovery.js";

export interface ProviderInfo {
  /**
   * Stable identifier — also used as the `source` on every Session this
   * provider emits, so it must be a valid SessionSource literal.
   */
  id: SessionSource;
  /** Short, human-readable name shown in logs and (where applicable) the UI. */
  displayName: string;
  /** One-line description for the README / Settings panel. */
  description: string;
  /**
   * Optional accent color (CSS value) — providers can suggest their brand
   * color so the UI can theme badges/stripes consistently. Hex or CSS var.
   */
  accentColor?: string;
}

export interface BaseProviderOptions {
  registry: SessionRegistry;
  /** Sink for diagnostic messages — strings get a `[provider-id]` prefix added. */
  onLog?: (msg: string) => void;
}

/** Lifecycle phases — exposed via `state` for diagnostics. */
export type ProviderState =
  | "idle"      // constructed but not yet started
  | "starting"  // onStart() in flight
  | "running"   // onStart() resolved successfully
  | "stopping"  // onStop() in flight
  | "stopped"   // onStart() failed or onStop() resolved
  | "skipped";  // start() was called but provider chose to skip (e.g. missing data dir)

/**
 * Implementers focus on three things:
 *   1. `info` — provider metadata
 *   2. `onStart` — open files / DBs / connections, seed the registry
 *   3. `backfillSession` — fetch events for a session the user just opened
 *
 * Everything else (state tracking, log prefixing, idempotent stop) is handled
 * here so subclasses don't reinvent it.
 */
export abstract class BaseProvider implements Provider {
  /** Required: identity + display info. Declared as a readonly field by the subclass. */
  abstract readonly info: ProviderInfo;

  protected readonly registry: SessionRegistry;
  private readonly _rawLog: ((msg: string) => void) | undefined;
  private _state: ProviderState = "idle";

  constructor(opts: BaseProviderOptions) {
    this.registry = opts.registry;
    this._rawLog = opts.onLog;
  }

  /** Provider id (mirrors info.id) — satisfies Provider interface. */
  get id(): SessionSource {
    return this.info.id;
  }

  /** Current lifecycle phase. */
  get state(): ProviderState {
    return this._state;
  }

  /**
   * Public lifecycle entry — handles state bookkeeping and error trapping
   * so ProviderManager doesn't need to know which phase a provider is in.
   */
  async start(): Promise<void> {
    if (this._state === "running" || this._state === "starting") return;
    this._state = "starting";
    try {
      await this.onStart();
      // onStart may set state to "skipped" itself (via skipStartup()); if it
      // didn't, we assume it ran successfully.
      if (this._state === "starting") this._state = "running";
    } catch (err) {
      this._state = "stopped";
      this.log(`failed to start: ${(err as Error).message}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this._state === "stopped" || this._state === "idle" || this._state === "skipped") return;
    this._state = "stopping";
    try {
      await this.onStop();
    } finally {
      this._state = "stopped";
    }
  }

  /** Subclass hook: do whatever you need to start serving sessions. */
  protected abstract onStart(): Promise<void>;

  /** Subclass hook: tear down all resources (timers, watchers, DB handles). */
  protected abstract onStop(): Promise<void>;

  /**
   * Subscribe-time backfill: when a client opens a session, this is called
   * on EVERY provider — so it MUST be a no-op for sessions you don't own.
   * Look up the sessionId in your local map and return early if you don't
   * know about it.
   */
  abstract backfillSession(sessionId: string): Promise<void>;

  // ─── helpers available to subclasses ───────────────────────────────────

  /**
   * Mark startup as deliberately skipped (e.g. dependency missing on disk).
   * Call from inside onStart() before returning. The provider stays alive but
   * does nothing — useful when a provider is optional.
   */
  protected skipStartup(reason: string): void {
    this.log(`skipping: ${reason}`);
    this._state = "skipped";
  }

  /** Prefixed logger. Use this instead of console.* so messages are routable. */
  protected log(msg: string): void {
    this._rawLog?.(`[${this.info.id}] ${msg}`);
  }

  /**
   * Discover a data location using the shared discovery primitive — candidate
   * path list with bounded filesystem search fallback. Logs results with the
   * provider's prefix so users can see where each piece of data was found.
   *
   * Returns the resolved path, or null when nothing matched. The caller
   * decides whether to skipStartup or surface a more specific error.
   */
  protected async discover(spec: DiscoverySpec): Promise<string | null> {
    return discover(spec, (msg) => this.log(msg));
  }
}
