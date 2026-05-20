# Adding a new provider to fleetwatch

A "provider" is anything that surfaces agent sessions into the shared
`SessionRegistry`. Today fleetwatch ships with two:

| Provider | Sources emitted | Where data lives |
|---|---|---|
| `Watcher` (`server/watcher.ts`) | `claude-code`, `cowork` | `~/.claude/projects/*.jsonl` + `~/Library/Application Support/Claude/local-agent-mode-sessions/.../*.jsonl` |
| `CursorProvider` (`server/providers/cursor.ts`) | `cursor` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |

Adding a third (Aider, Continue, GitHub Copilot transcript, a custom internal
agent — anything) is a small commitment if you follow the pattern.

## The recipe — 5 steps

### 0. Plan how you'll discover your data

Providers don't hardcode a single path. Each one declares a `DiscoverySpec`
that fleetwatch resolves at startup:

1. **Try ordered candidates** — env var override → primary default → per-OS
   alternatives.
2. **Fall back to bounded filesystem search** — looks under `searchRoots`
   for files/dirs matching `searchName`, depth-capped, ignoring large dirs
   (`node_modules`, `.git`, photo libraries, etc.).
3. **Verify with a predicate** — `verify()` opens each candidate and confirms
   it's actually your provider's data (not somebody else's). This is what
   stops Cursor's `state.vscdb` discovery from picking up VSCode's same-named
   file, or Cowork's JSONL discovery from grabbing Claude Code's.

You get this for free by calling `this.discover(spec)` from inside `onStart`.

### 1. Add your source to the wire type

`shared/types.ts`:

```ts
export type SessionSource =
  | "claude-code"
  | "cowork"
  | "cursor"
  | "your-thing";          //  ← add here
```

This is the only client/server-shared identifier — make it stable and short.

### 2. Create the provider file

`server/providers/your-thing.ts`:

```ts
import { BaseProvider, type BaseProviderOptions, type ProviderInfo } from "./base.js";
import type { SessionEvent } from "../../shared/types.js";

export interface YourProviderOptions extends BaseProviderOptions {
  // Any provider-specific knobs (paths, intervals, API keys, …).
}

export class YourProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: "your-thing",
    displayName: "Your Thing",
    description: "One-liner shown in settings.",
    accentColor: "#hexcolor",
  };

  constructor(opts: YourProviderOptions) {
    super(opts);
    // … store any extra config locally.
  }

  protected async onStart(): Promise<void> {
    // 1. Find your data via discovery (candidates + bounded search + verify).
    const dataPath = await this.discover({
      label: "Your data file",
      candidates: [
        process.env.YOUR_THING_PATH,
        path.join(HOME, ".your-thing", "store.db"),     // primary default
        path.join(HOME, "Library/Application Support/YourThing/store.db"),
        path.join(HOME, ".config/your-thing/store.db"),
      ],
      searchRoots: [
        path.join(HOME, "Library/Application Support"),
        path.join(HOME, ".config"),
      ],
      searchName: "store.db",
      pathMustContain: "YourThing", // disambiguate vs other tools using same filename
      verify: async (p) => {
        // Open it and check for a marker that ONLY your data has —
        // a magic header, a unique table, a JSON key pattern, etc.
        return true;
      },
    });
    if (!dataPath) { this.skipStartup("not installed"); return; }

    // 2. Open files / DBs / connections.
    // 3. Discover existing sessions and seed them:
    //      this.registry.upsertMeta(sessionId, { source: "your-thing", … });
    //      this.registry.setTitle(sessionId, { aiTitle: "…" });
    //      this.registry.setActivity(sessionId, { lastEventAt: ts, eventCount: n });
    // 4. Wire your change detection (file watcher / poller / SSE).
    this.log(`surfaced N session(s) from ${dataPath}`);
  }

  protected async onStop(): Promise<void> {
    // Close watchers, timers, DB handles. Idempotent.
  }

  async backfillSession(sessionId: string): Promise<void> {
    // Called when ANY client opens ANY session — so MUST be a no-op for
    // sessions you don't own.
    if (!this.knowsAbout(sessionId)) return;

    // Load (or top-up) events from your source and feed them in:
    //   const ev: SessionEvent = { sessionId, ts, type: "user", text: "…" };
    //   this.registry.appendEvent(sessionId, ev);
  }

  private knowsAbout(sessionId: string): boolean {
    // your local map / set
    return false;
  }
}
```

The base class handles:
- Lifecycle state (`idle → starting → running → stopping → stopped`/`skipped`)
- Per-provider log prefix (`[your-thing] foo`)
- `skipStartup(reason)` helper for missing optional dependencies
- Idempotent `start()` / `stop()` — safe to call repeatedly
- `discover(spec)` for resilient data-location resolution (env var > known
  paths > bounded filesystem search, with mandatory `verify()` to avoid
  mistaking another provider's data for yours)

### 3. Map your data into our event shape

The registry expects normalized `SessionEvent`s (`shared/types.ts`):

```ts
interface SessionEvent {
  sessionId: string;
  ts: number;             // epoch ms
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system" | "summary" | "attachment" | "thinking";
  text?: string;
  thinking?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolUseRef?: string;
  toolResultText?: string;
  toolResultIsError?: boolean;
  // …
}
```

Status (running / awaiting / errored / idle / compacted) is derived
automatically from the event stream — you don't need to compute it.

### 4. Wire your provider into bootstrap

`server/index.ts` — find the provider assembly block:

```ts
const providers = new ProviderManager();
providers.add(new Watcher({ registry, onLog: log }));

if (!cursorDisabled) {
  providers.add(new CursorProvider({ registry, onLog: log }));
}

if (!yourThingDisabled) {                  //  ← add a clause
  providers.add(new YourProvider({ registry, onLog: log /*, options… */ }));
}
```

Add an opt-out flag if your provider does meaningful I/O:
- CLI: `--no-your-thing`
- Env: `YOUR_THING_DISABLED=1`
- Both should reach `args` / `envFlag(…)`.

### 5. Add UI affordances (optional)

If you want a dedicated tab + badge:

- `src/screens/SessionList.tsx` — append to `TABS`:
  ```ts
  { id: "your-thing", label: "YourThing", matches: (s) => s.source === "your-thing" },
  ```
- `src/components/SessionRow.tsx` — add to `SOURCE_STYLE`:
  ```ts
  "your-thing": { label: "YT", color: "#hex", bg: "rgba(…)" },
  ```
- `src/components/ProviderIcon.tsx` — add an icon case so the badge renders.

## Things to keep in mind

**Lazy work.** Don't pull megabytes of data at startup just because the source
exists. Surface metadata only; load events when the client subscribes
(`backfillSession`). The Cursor provider is a good reference — it lists 200
recent conversations cheaply, then queries bubbles only for opened ones.

**Idempotent backfill.** `backfillSession(id)` is fanned out to ALL providers
on every subscribe. Yours must return early when it doesn't own the session
and must not double-emit events when called repeatedly for one it does own.
Track a per-session "highwater mark" (rowid, byte offset, message id).

**Read-only is non-negotiable.** fleetwatch never writes to source data. If
your provider opens a file/DB/socket, do it read-only and survive concurrent
mutation by the source tool.

**Optional dependencies.** If your provider depends on something that may
not exist on the user's machine (a binary, a directory, an API token),
detect that in `onStart()` and call `this.skipStartup(reason)`. Don't throw —
the user shouldn't have to opt out of features they don't have.
