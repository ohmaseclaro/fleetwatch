# Multi-provider plan: source tabs + Cursor support

> **Status:** Phase A + Phase B (B.1, B.2, B.3, B.4 stage 1) **shipped**.
> Verified end-to-end: 130 Code + 22 Cowork + 200 Cursor sessions surfaced on
> a real machine. Cursor backfill works (50-event sample returned user +
> assistant bubbles with correct text content). Auth (JWT + optional bcrypt
> password) unchanged. ngrok onboarding and `--no-cursor` opt-out wired.


## Findings from sub-agent investigation

| Tab in Claude desktop | Storage location | Format | Tail strategy |
|---|---|---|---|
| **Code** | `~/.claude/projects/*/<uuid>.jsonl` | append-only JSONL | ✅ already tailed (chokidar + inode/offset) |
| **Cowork** | `~/Library/Application Support/Claude/local-agent-mode-sessions/.../<uuid>.jsonl` | append-only JSONL | ✅ already tailed (behind `--include-cowork` flag) |
| **Chat** | `~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.*` | LevelDB blob — only conversation list metadata, **no message bodies** | ❌ **Cloud-only.** No local source. Would need authenticated HTTP/SSE against `claude.ai`. Out of scope for v1. |
| **Cursor IDE** | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | SQLite (30 GB, ~1.9M rows in `cursorDiskKV`) | 🟡 **Polling via WAL watch** (SQLite is not append-only) |

Key Cursor tables/namespaces:
- `composerData:<conversationId>` (~3.8K rows) — conversation envelopes (model, mode, title, createdAt)
- `bubbleId:<conversationId>:<messageId>` (~895K rows) — individual user + assistant messages (JSON)
- `messageRequestContext:<...>` (~8K rows) — per-request context bundle
- Workspace mapping via `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb` (`ItemTable` → `composer.composerData` links `composerId` ↔ workspace)

The DB is locked while Cursor runs — must open with read-only/immutable URI:
```
file:.../state.vscdb?mode=ro&immutable=1
```

---

## Phase A — Three-tab UI for what we already have (small, ships today)

We already capture **Code** and **Cowork**. The change is purely UI:

### Backend (server)
1. **Always start Cowork watcher** when the directory exists, instead of gating on `--include-cowork`. Sessions already carry `source: "claude-code" | "cowork"` so they don't get conflated.
2. Drop `includeCowork` preference, or repurpose it as "show cowork sessions in the list" (a *display* toggle, not a *scanning* toggle).

### Frontend (`SessionList.tsx`)
1. Replace the single "All / Active" toggle with a three-pill tab row at the top of the list:
   ```
   [ All ] [ Code ] [ Cowork ]  ←  (Chat shown as "coming soon" badge, disabled)
   ```
2. Filter by `session.source` instead of `status`.
3. Status filtering ("active only") becomes a secondary chip below — or a setting.
4. Sort within each tab by `lastUserMessageAt` desc (already wired).

### Visual distinction
- Show a tiny source badge on each `SessionRow` (e.g. `</>` for Code, `⫶` for Cowork).
- Color: Code uses the existing accent; Cowork gets a muted secondary color.

### "Chat" tab placeholder
Render the Chat tab as visible but disabled with a small tooltip: *"Chat conversations live on claude.ai — we can't read them from local files. Drop a comment if you want this via the Anthropic API."*

**Estimated diff size:** ~150 LOC, touches `SessionList.tsx`, `SessionRow.tsx`, `watcher.ts` (drop the gate), `pairing.ts` (remove unused pref or repurpose).

---

## Phase B — Cursor provider (larger, ships next)

### B.1 Provider abstraction (refactor existing code)
Right now `Watcher` is a single class hard-wired to JSONL tailing. Refactor into a `Provider` interface so each source plugs in identically:

```typescript
interface Provider {
  readonly id: "claude-code" | "cowork" | "cursor";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Called when a client subscribes to a session — loads recent events. */
  backfillSession(sessionId: string): Promise<void>;
}
```

- Rename current `Watcher` → `JsonlProvider` (works for both Code and Cowork — same JSONL format, different roots).
- Move JSONL-specific parsing into the provider; the registry stays format-agnostic.

### B.2 `CursorProvider` implementation
New file `server/providers/cursor.ts`:

1. **Dependency:** `better-sqlite3` (sync API is fine for this — we're not in a hot loop) or `node:sqlite` (Node 22+). Pick `better-sqlite3` for broader Node compat.
2. **Open DB** read-only immutable:
   ```typescript
   const db = new Database(dbPath, { readonly: true, fileMustExist: true });
   db.pragma("journal_mode = WAL");  // already WAL — just ensures we read it
   ```
3. **Workspace map** — at startup, scan all `workspaceStorage/<hash>/state.vscdb` files, run `SELECT key, value FROM ItemTable WHERE key = 'composer.composerData'`, parse JSON, build `Map<composerId, workspaceLabel>`.
4. **Initial session list** — query envelopes:
   ```sql
   SELECT key, value FROM cursorDiskKV
   WHERE key LIKE 'composerData:%'
   ```
   Emit one `Session` per envelope. Title = composer's `name` field (or first user message preview). `projectLabel` = workspace from the map above.
5. **Backfill events for an opened session** — when client subscribes:
   ```sql
   SELECT key, value FROM cursorDiskKV
   WHERE key LIKE 'bubbleId:<composerId>:%'
   ORDER BY rowid
   ```
   Map each bubble's JSON to our `SessionEvent`:
   - `type: 1` → user message
   - `type: 2` → assistant message
   - `toolFormerCalls`, `lints`, `codeBlockDiff` references → tool events
6. **Live updates** — use `chokidar.watch(dbPath + "-wal")`. WAL is rewritten on every commit; the `change` event is a cheap signal. On change, re-query with `rowid > lastSeenRowid` for any subscribed session.
7. **No-op when no sessions are open** — exactly like the JSONL provider's lazy subscription model, avoiding repeated polling of the 30 GB DB.

### B.3 Wire-format changes
- Extend `SessionSource` type: `"claude-code" | "cowork" | "cursor"`
- `Session` gets `provider: "claude" | "cursor"` (derived from source) so the UI can group by provider too.
- New `EventBubble` cases for Cursor-specific event subtypes (or coerce them into our existing user/assistant/tool buckets).

### B.4 Provider selector UI
Two stages of refinement:

**Stage 1 (minimal):** Add Cursor as a fourth tab next to Code/Cowork/Chat:
```
[ All ] [ Code ] [ Cowork ] [ Cursor ] [ Chat (soon) ]
```

**Stage 2 (richer):** Group by provider in Settings:
- Settings → "Sources" panel with toggles:
  - ☑ Claude Code (`~/.claude/projects`)
  - ☑ Cowork (`~/Library/.../local-agent-mode-sessions`)
  - ☐ Cursor (`~/Library/.../Cursor/...`)
- Each toggle starts/stops the corresponding provider live.

### B.5 Risk / mitigation
- **30 GB DB scans** — never `SELECT *`. Always filter by `key LIKE 'composerData:%'` or `key LIKE 'bubbleId:<id>:%'` (indexed on key). Confirm with `EXPLAIN QUERY PLAN`.
- **Cursor running concurrently** — `mode=ro&immutable=1` URI is safe; we don't hold write locks.
- **WAL churn while Cursor is busy** — debounce the WAL change handler (e.g. 250 ms) so we don't requery 50× per second during a Cursor edit storm.

**Estimated diff size:** ~600 LOC. New files: `server/providers/cursor.ts`, `server/providers/jsonl.ts` (extracted from `watcher.ts`), `server/providers/index.ts`. Touches: `server/index.ts`, `shared/types.ts`, `SessionList.tsx`, `EventBubble.tsx`.

---

## Phase C — Claude Chat (future, optional)

Would require:
- Reusing the user's `claude.ai` session cookie (read from the Electron app's cookie store).
- Polling/SSE against `https://claude.ai/api/organizations/<org>/chat_conversations/...`
- Significant scope: API client, auth refresh, rate-limit handling.

Defer until users explicitly ask for it.

---

## Suggested execution order

1. **Now:** Phase A (3 tabs for Code/Cowork) — quick win, ~half a day.
2. **Next:** Phase B.1 + B.2 + B.4 stage 1 — Cursor provider with simple tab — ~1–2 days.
3. **Later:** Phase B.4 stage 2 (Settings panel for sources) once we have ≥2 providers worth toggling.
4. **Maybe never:** Phase C — only if users request it.
