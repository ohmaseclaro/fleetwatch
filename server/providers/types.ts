/**
 * Provider abstraction — each data source (Claude JSONL files, Cursor SQLite,
 * potentially others) implements this interface so the rest of the daemon
 * doesn't have to care where sessions come from.
 *
 * Most providers should extend `BaseProvider` in ./base.ts which gives you
 * lifecycle bookkeeping + log prefixing for free; this interface exists
 * for the few cases where you really need a custom class.
 */
import type { SessionSource } from "../../shared/types.js";
import type { ProviderInfo, ProviderState } from "./base.js";

export interface Provider {
  /** Stable ID for logging — usually matches the SessionSource the provider emits. */
  readonly id: SessionSource;
  /** Optional metadata — present when extending BaseProvider. */
  readonly info?: ProviderInfo;
  /** Optional state — present when extending BaseProvider. */
  readonly state?: ProviderState;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Backfill the most-recent events for a single session into the registry.
   * Called when a client subscribes. Must be a no-op when the provider does
   * not own this session (so it's safe to call on every provider).
   */
  backfillSession(sessionId: string): Promise<void>;
}

/**
 * Coordinates a collection of providers. Lets the rest of the app interact
 * with "all providers" without knowing the concrete types.
 */
export class ProviderManager {
  private providers: Provider[] = [];

  add(provider: Provider): void {
    this.providers.push(provider);
  }

  list(): Provider[] {
    return this.providers.slice();
  }

  /** Snapshot of every provider's info + current lifecycle state. */
  status(): Array<{ id: SessionSource; state: ProviderState | "unknown"; info?: ProviderInfo }> {
    return this.providers.map((p) => ({
      id: p.id,
      state: p.state ?? "unknown",
      info: p.info,
    }));
  }

  async startAll(): Promise<void> {
    for (const p of this.providers) {
      try {
        await p.start();
      } catch (err) {
        // One provider failing should not stop others.
        // eslint-disable-next-line no-console
        console.error(`[providers] ${p.id} failed to start:`, (err as Error).message);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      this.providers.map((p) => p.stop().catch(() => {})),
    );
  }

  /**
   * Fan out a backfill request to every provider — each is a no-op when it
   * doesn't own the session, so this is cheap and lets us avoid maintaining
   * a sessionId → provider mapping at this layer.
   */
  async backfillSession(sessionId: string): Promise<void> {
    await Promise.all(
      this.providers.map((p) => p.backfillSession(sessionId).catch(() => {})),
    );
  }
}
