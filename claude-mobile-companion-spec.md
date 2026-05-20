# Claude Mobile Companion — Technical Specification

A mobile app that pairs with a desktop running Claude Code, lists every active agent ordered by most-recent user activity, and streams each session's events in real time. Pair by scanning a QR code on the desktop. End-to-end encrypted. Works on both iOS and Android from a single Capacitor codebase.

---

## 1. Goals & non-goals

### Goals
- **Zero-config pairing.** User opens a panel on desktop → QR code appears → phone scans it → paired. No accounts, no port-forwarding, no manual key entry.
- **Live "what is Claude doing" view** for every session and subagent the user has on their machine, sorted by most recent human interaction.
- **Read-only in v1.** No sending messages from phone yet; just observability. (Future versions can add it; the pubsub channel is bidirectional from day one.)
- **End-to-end encrypted.** The relay sees only ciphertext. Pairing is one-shot; the QR code is the only secret material that ever touches an unsecured channel.
- **Cross-platform from one codebase.** iOS and Android via Capacitor + React.
- **Visually consistent with Claude.** Warm-cream / terracotta palette, generous whitespace, monospace tool blocks.

### Non-goals (for v1)
- Two-way chat (sending messages from the phone).
- Multi-user / team views.
- Persisting history on the phone beyond the current session.
- Watching anything other than Claude Code (Cowork desktop sessions are listed only if they write to `~/Library/Application Support/Claude/local-agent-mode-sessions/` — see §8).
- Web-only / browser version (Capacitor build only).

---

## 2. System architecture

Three components, talking over one encrypted pubsub channel.

```
┌──────────────────────────┐                              ┌────────────────────────┐
│   Mac / Linux desktop    │                              │      Mobile app        │
│                          │                              │                        │
│  ┌────────────────────┐  │     ┌───────────────────┐    │   ┌────────────────┐   │
│  │  claudemobiled     │──┼────▶│  Ably (or CF DO)  │◀───┼───│  React + Cap.  │   │
│  │  (Rust daemon)     │  │     │   pubsub relay     │    │   │   WebView      │   │
│  │                    │  │     │  (sees ciphertext) │    │   │                │   │
│  │  • FSEvents watch  │  │     └───────────────────┘    │   │   • QR scan    │   │
│  │  • JSONL parse     │  │                              │   │   • Session    │   │
│  │  • status engine   │  │                              │   │     list       │   │
│  │  • Noise / X25519  │  │                              │   │   • Live event │   │
│  │  • QR pairing UI   │  │                              │   │     stream     │   │
│  │  • menubar app     │  │                              │   │                │   │
│  └────────────────────┘  │                              │   └────────────────┘   │
└──────────────────────────┘                              └────────────────────────┘
        ▲                                                              ▲
        │ reads:                                                       │ camera, push
        │   ~/.claude/projects/**/*.jsonl                              │
        │   ~/.claude/history.jsonl                                    │
        │   ~/Library/Application Support/Claude/local-agent-          │
        │     mode-sessions/**/*.jsonl  (Cowork desktop sessions)      │
```

### High-level flow

1. **Install** — User installs `claudemobiled` on the desktop (Homebrew tap or signed `.pkg`) and the mobile app from App Store / Play Store.
2. **Pair** — User opens menubar → "Pair new device". Daemon generates an ephemeral X25519 keypair, registers a channel on Ably, and renders a QR code containing the channel ID + relay URL + ephemeral public key + nonce.
3. **Scan** — Phone scans QR. Phone generates its own keypair, performs an X25519 handshake, derives a shared symmetric key, and joins the channel. Both sides confirm via a short authenticated commitment.
4. **Stream** — Daemon watches the filesystem, parses JSONL deltas, encrypts each event, and publishes to the channel. Phone subscribes, decrypts, and renders.
5. **Persist** — Phone stores the channel ID + long-term key in secure storage (Keychain / Keystore) for reconnection.

---

## 3. Data model

### Session

```ts
type Session = {
  id: string;                  // UUID from jsonl filename
  projectPath: string;         // decoded from directory name
  projectLabel: string;        // last 2 path segments, e.g. "lahzo / lahzo-monorepo"
  status: SessionStatus;
  lastUserMessageAt: number;   // unix ms, from history.jsonl or latest type:user line
  lastEventAt: number;         // unix ms, from latest jsonl line of any kind
  lastUserMessagePreview: string;  // first 80 chars of most recent user prompt
  currentActivity?: string;    // human-readable "what's happening", e.g. "Running Edit on …"
  isSubagent: boolean;
  parentSessionId?: string;    // if subagent
  source: "claude-code" | "cowork";
};

type SessionStatus =
  | "running"           // assistant is mid-turn, tool_use without matching tool_result, or jsonl mtime < 5s ago
  | "running-tool"      // specifically inside a tool call
  | "awaiting-user"     // last line is completed assistant message, no further events
  | "idle"              // no activity for > 60s and ended cleanly
  | "errored"           // last line indicates error/cancel
  | "compacted";        // session was compacted; a new sibling jsonl exists
```

### Event (one per JSONL line)

```ts
type Event = {
  sessionId: string;
  ts: number;               // unix ms
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system" | "summary";
  // For type=user/assistant: rendered text content
  text?: string;
  // For type=tool_use:
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  // For type=tool_result:
  toolUseRef?: string;
  toolResultText?: string;
  toolResultIsError?: boolean;
  // Aggregate model metadata
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
};
```

### Wire frames (over the channel)

All frames are JSON inside an XChaCha20-Poly1305 envelope (see §7).

```ts
type Frame =
  | { kind: "hello"; agentVersion: string; hostname: string; platform: "macos" | "linux"; ts: number }
  | { kind: "session_list"; sessions: Session[]; ts: number }
  | { kind: "session_upsert"; session: Session }
  | { kind: "session_event"; event: Event }
  | { kind: "subscribe"; sessionIds: string[] }     // phone → desktop
  | { kind: "unsubscribe"; sessionIds: string[] }   // phone → desktop
  | { kind: "heartbeat"; ts: number }
  | { kind: "revoke" };                              // either side
```

---

## 4. Desktop agent (`claudemobiled`, Rust)

### 4.1 Responsibilities

1. Watch `~/.claude/projects/` and `~/Library/Application Support/Claude/local-agent-mode-sessions/` for new and changed `.jsonl` files.
2. Maintain an in-memory `HashMap<SessionId, SessionState>` that always reflects the union of (a) parsed JSONL state and (b) most-recent user-message time from `~/.claude/history.jsonl`.
3. Run a status engine that derives `SessionStatus` from the JSONL tail.
4. Expose a small menubar UI for pairing & revoking devices.
5. Maintain one persistent WebSocket connection to Ably per paired device.
6. Encrypt every outgoing frame with the per-device symmetric key.

### 4.2 Crate layout

```
claudemobiled/
├─ Cargo.toml
├─ src/
│  ├─ main.rs              # entry point, CLI flags, tracing init
│  ├─ config.rs            # config file at ~/.config/claudemobiled/config.toml
│  ├─ watcher.rs           # notify crate, recursive watcher
│  ├─ jsonl/
│  │  ├─ mod.rs
│  │  ├─ tail.rs           # streaming line reader that survives file rotation
│  │  ├─ parse.rs          # serde structs for each jsonl event variant
│  │  └─ history.rs        # specifically for ~/.claude/history.jsonl
│  ├─ session/
│  │  ├─ mod.rs            # SessionRegistry
│  │  ├─ status.rs         # SessionStatus derivation rules
│  │  └─ ordering.rs       # sort-by-most-recent-user
│  ├─ crypto/
│  │  ├─ mod.rs            # X25519 + HKDF + XChaCha20-Poly1305
│  │  └─ pairing.rs        # QR payload encode/decode, handshake
│  ├─ relay/
│  │  ├─ mod.rs
│  │  └─ ably.rs           # WebSocket client
│  ├─ ui/
│  │  ├─ menubar.rs        # tao + tray-icon, or native macOS via objc2
│  │  └─ pairing_window.rs # tiny window with QR + status
│  └─ ipc.rs               # local socket for the menubar UI to talk to the daemon
└─ tests/
```

### 4.3 Key dependencies

- `notify` — cross-platform file watching (FSEvents on macOS).
- `tokio` — async runtime.
- `serde` + `serde_json` — JSONL parsing.
- `tokio-tungstenite` — WebSocket client for Ably.
- `dalek-cryptography/x25519-dalek` — handshake.
- `chacha20poly1305` — symmetric AEAD.
- `hkdf` + `sha2` — key derivation.
- `qrcode` — render QR PNG for the pairing window.
- `tray-icon` + `tao` — cross-platform menubar / system tray.
- `directories` — locate `~/.claude` portably.
- `tracing` + `tracing-subscriber` — logs.

### 4.4 File watcher design

Two watched roots:

- `~/.claude/projects/` (recursive) — Claude Code sessions.
- `~/Library/Application Support/Claude/local-agent-mode-sessions/` (recursive, macOS only) — Cowork desktop sessions.

The watcher is **inotify/FSEvents-driven**, never polling. Two event types matter:

- `Modify(Data)` on an existing `.jsonl` → seek to last known offset, read new lines, parse, fan out as `session_event` frames.
- `Create(File)` on `*.jsonl` → register a new session, then proceed as above. New files come from (a) new session start or (b) session compaction (the daemon detects compaction by inspecting the first line for a `summary` field referencing the prior session).

A separate dedicated watcher tracks `~/.claude/history.jsonl` since it's flat (no nested dirs) and updates the canonical `lastUserMessageAt` for cross-session ordering — see §9.

**Tailing across rotation.** The daemon stores `(inode, offset)` per file. On a `Modify`, if the inode changed it means the file was rotated; rewind to offset 0 of the new inode and emit a `session_upsert` with the fresh state.

### 4.5 Status engine

The status derivation runs on every JSONL line and every 1s tick (for "idle" transitions). Rules, evaluated top-down:

1. If the most recent line is `type: "tool_use"` and there is no matching `tool_result` for its `tool_use_id` yet → **running-tool**, `currentActivity = "Running {toolName}…"`.
2. If the most recent line was written in the last 5s and is `type: "assistant"` with a partial / non-stop_reason — but **note**: Claude Code only flushes completed messages, so in practice this case is rare. Treat as **running**.
3. If the most recent line is `type: "assistant"` with `stop_reason: "end_turn"` and no later events → **awaiting-user**.
4. If the most recent line is a `type: "result"` with `subtype: "error"` or `is_error: true` → **errored**.
5. If the most recent line is a `summary` event referencing this session and a sibling jsonl exists with a newer mtime → **compacted**.
6. Otherwise, if no events in the last 60s → **idle**.
7. Otherwise → **running**.

A 5-second debounce smooths rapid flips between `running-tool` and `running` during tool-heavy turns.

### 4.6 Pairing flow (desktop side)

```
1. User clicks "Pair new device" in menubar.
2. Daemon:
   a. Generates ephemeral X25519 keypair (eph_sk, eph_pk).
   b. Generates 32-byte nonce.
   c. Allocates channel ID = uuidv4().
   d. Subscribes to channel `pair:{channelId}` on Ably.
   e. Renders QR:
        claudemobile://pair?
          relay=wss://realtime.ably.io
          &channel={channelId}
          &epk={base64url(eph_pk)}
          &nonce={base64url(nonce)}
          &v=1
3. Phone scans, sends `{ kind: "pair_hello", phone_epk }` on `pair:{channelId}`.
4. Daemon computes shared = X25519(eph_sk, phone_epk).
   Derives key = HKDF-SHA256(shared, salt=nonce, info="claudemobile/v1").
   Sends `{ kind: "pair_ack", short_auth_string: SAS(key) }`.
5. Both UIs display the same 4-word SAS (e.g. "amber-canyon-river-quiet").
   User taps "Match" on phone to confirm.
6. Daemon writes the pairing to ~/.config/claudemobiled/devices.toml
   (device_id, key, phone_label).
   Phone writes the pairing to Keychain/Keystore.
7. Daemon migrates the device from `pair:{channelId}` to `dev:{deviceId}` and
   starts publishing the session list.
```

The Short Authentication String (SAS) defeats a relay-MITM: a malicious relay that swaps `phone_epk` would produce different keys on each side, and the SAS words wouldn't match.

### 4.7 Distribution

- **Homebrew tap** for v1: `brew install augustoclaro/tap/claudemobiled`. Single statically-linked binary.
- Installs a `launchd` user agent at `~/Library/LaunchAgents/com.augustoclaro.claudemobiled.plist` so it starts at login.
- v1.1: signed + notarized `.pkg` installer with a minimal menubar SwiftUI shell.

### 4.8 Privacy controls

- "Show only my code projects" toggle: excludes any session whose `cwd` starts with `~/Library/`, `/private/`, or `/tmp/`.
- Per-project exclude list in `config.toml`.
- "Pause streaming" menubar toggle.
- Reading from disk only — daemon never writes to `~/.claude/`.

---

## 5. Tunnel / pubsub

### 5.1 v1 choice: Ably

**Why Ably for v1:**
- Free tier: 3M messages/month, 200 peak concurrent connections. A heavy personal user emits ~5–10k frames/day, so the free tier covers ~10 users comfortably.
- One WebSocket per device, zero infra to operate.
- Built-in channel auth via JWT-style "token requests" — the daemon mints scoped tokens per device, so a compromised phone can't read other devices' channels.
- E2EE is layered on top: Ably sees opaque base64 ciphertext only.

### 5.2 Channel scheme

```
dev:{deviceId}                  # canonical channel for a paired phone
dev:{deviceId}:session:{id}     # per-session subscription, used when phone is on a detail view
pair:{ephemeralChannelId}       # one-shot, deleted after handshake completes
```

The daemon presence-publishes on `dev:{deviceId}` always (for the session list). The phone subscribes to `dev:{deviceId}:session:{id}` only when the user opens a session detail view, and unsubscribes on back-navigation. This keeps Ably message volume proportional to active interest.

### 5.3 Wire encoding

Each Ably message:

```
{
  "iv":  base64url(24-byte XChaCha20 nonce),
  "ct":  base64url(ciphertext || 16-byte Poly1305 tag),
  "v":   1
}
```

Plaintext is a `Frame` (see §3) serialized as canonical JSON. Nonce is incremented per-message; the daemon and phone each maintain their own counter and prefix the nonce with a single byte (`0x00` for desktop→phone, `0x01` for phone→desktop) to avoid collisions.

### 5.4 Migration path: self-hosted

When the user base grows past Ably's free tier (or for full sovereignty), the same wire format runs over **Cloudflare Workers + Durable Objects**:

- One Durable Object per `deviceId`.
- Hibernation API keeps idle connections free.
- ~$5/mo flat for substantial usage.
- Same channel naming, same encryption, only the WebSocket URL changes.

The agent's `relay` module is split so swapping `relay::ably` for `relay::cloudflare` is a one-file change.

---

## 6. Mobile app (Capacitor + React)

### 6.1 Stack

| Layer | Choice |
|---|---|
| Shell | Capacitor 6 |
| Web framework | React 18 + Vite |
| Styling | Tailwind CSS, design tokens matching Claude palette |
| State | Zustand (light, no Redux ceremony) |
| Routing | React Router |
| Camera / QR | `@capacitor-mlkit/barcode-scanning` (Google ML Kit, free, on-device) |
| Secure storage | `@capacitor-community/secure-storage` (Keychain on iOS, Keystore on Android) |
| WebSocket | Native `WebSocket` API — Ably JS SDK is too heavy; use raw WS + JSON |
| Crypto | `libsodium.js` (well audited, identical primitives to Rust side) |
| Push notifications (v1.1) | `@capacitor/push-notifications` + APNs / FCM |
| Icons | `lucide-react` |

### 6.2 Project layout

```
claude-mobile/
├─ capacitor.config.ts
├─ ios/
├─ android/
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ routes.tsx
│  ├─ screens/
│  │  ├─ Onboarding.tsx
│  │  ├─ ScanQR.tsx
│  │  ├─ PairConfirm.tsx       # SAS confirmation
│  │  ├─ SessionList.tsx
│  │  ├─ SessionDetail.tsx
│  │  └─ Settings.tsx
│  ├─ components/
│  │  ├─ SessionRow.tsx
│  │  ├─ StatusIcon.tsx
│  │  ├─ EventBubble.tsx
│  │  ├─ ToolCard.tsx
│  │  └─ ConnectionPill.tsx    # connected / reconnecting indicator
│  ├─ lib/
│  │  ├─ crypto.ts             # libsodium wrappers, matched to daemon
│  │  ├─ transport.ts          # WebSocket + reconnect logic
│  │  ├─ pairing.ts            # handshake, SAS derivation
│  │  ├─ store.ts              # zustand store: sessions, events, status
│  │  └─ time.ts
│  ├─ design/
│  │  ├─ tokens.css            # CSS variables (see §6.5)
│  │  └─ tailwind.config.js
│  └─ types.ts                 # Frame, Session, Event mirror of daemon types
└─ package.json
```

### 6.3 Screens

#### Onboarding
One-screen explanation: "Open the Claude menubar app on your computer and tap 'Pair new device'." CTA: "Scan QR code".

#### Scan QR
Full-bleed camera viewfinder with a rounded square targeting overlay. On detection, validates the `claudemobile://pair?...` URI scheme, otherwise shows "Not a Claude Mobile code".

#### PairConfirm (SAS)
Shows 4 words ("amber · canyon · river · quiet"). Copy: "Check that the desktop shows the same four words, then tap Match." Buttons: **Match** / **Cancel**.

#### SessionList
Main screen. Vertical list of sessions sorted by `lastUserMessageAt` desc. Each row:

```
┌─────────────────────────────────────────────┐
│  [●]  lahzo-monorepo / great-dijkstra       │
│       "let's also handle the case where…"   │
│       Running Edit on packages/ui/Card.tsx   │
│                                  · 12s ago   │
└─────────────────────────────────────────────┘
```

Status icon colors map to `SessionStatus` (see §6.5).

Pull-to-refresh forces a `session_list` request. Otherwise the list is push-driven via `session_upsert` frames.

#### SessionDetail
Header: project label, status pill, "Disconnect when leaving" toggle.

Body: scrolling reverse-chronological event stream (newest at top, with optional "jump to live" toggle for chronological order). Each event renders as one of:

- **User bubble** — right-aligned, terracotta border, prose.
- **Assistant bubble** — left-aligned, cream background, prose with code blocks.
- **Tool card** — collapsed by default, shows `🔧 Edit` + filename. Expands to show diff or output. Color-coded by tool family (Read/Write/Edit, Bash, Grep, etc.).
- **System** — gray, small, italic ("Session compacted", "Subagent spawned").

Live indicator: a small pulsing dot in the header when status is `running` or `running-tool`. When a tool is mid-flight, its card shows a spinner and elapsed timer.

#### Settings
Paired devices list (desktops, plural — multi-desktop is v1.1).  
"Show system / library sessions" toggle.  
"Revoke pairing" per device.

### 6.4 List ordering — the canonical question

The session list is sorted by `lastUserMessageAt` (desc), exactly the question you raised. The desktop agent computes it like this:

1. Tail `~/.claude/history.jsonl`. Each line has `{ display, project, timestamp }`. Map `project` to its encoded directory name and update the latest session in that directory.
2. For sessions where `history.jsonl` doesn't yet have an entry (rare — agent-spawned subagents), fall back to scanning the session's JSONL for the last `type: "user"` line's `timestamp`.
3. Emit `session_upsert` whenever `lastUserMessageAt` changes for any session.

The phone never sorts on `lastEventAt` — that would let a long-running tool keep pushing a stale session to the top. Sorting on `lastUserMessageAt` produces "the chat I most recently typed into," which is the natural mental model.

### 6.5 Design system

CSS tokens (`src/design/tokens.css`):

```css
:root {
  /* Backgrounds */
  --bg:               #FAF9F5;     /* warm cream */
  --bg-elevated:      #FFFFFF;
  --bg-subtle:        #F0EEE6;

  /* Text */
  --text:             #3D3929;     /* deep ink, slightly warm */
  --text-muted:       #6B6555;
  --text-faint:       #9B9486;

  /* Accents */
  --accent:           #C96442;     /* Claude terracotta */
  --accent-soft:      #E7B9A5;
  --accent-bg:        #FBEFE9;

  /* Status */
  --status-running:   #2F855A;     /* green */
  --status-tool:      #B7791F;     /* amber */
  --status-waiting:   #4A5568;     /* slate */
  --status-idle:      #9B9486;     /* faint */
  --status-error:     #C53030;     /* red */

  /* Borders */
  --border:           #E6E2D6;
  --border-strong:    #C9C3B3;

  /* Radii & shadows */
  --radius-sm:        8px;
  --radius:           12px;
  --radius-lg:        16px;
  --shadow-sm:        0 1px 2px rgba(45, 38, 25, 0.04);
  --shadow:           0 2px 12px rgba(45, 38, 25, 0.08);

  /* Type */
  --font-sans:        "Inter", -apple-system, "SF Pro Text", system-ui, sans-serif;
  --font-serif:       "Tiempos Text", Georgia, serif;   /* for assistant bubbles */
  --font-mono:        "JetBrains Mono", ui-monospace, "SF Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:             #1F1D18;
    --bg-elevated:    #26241E;
    --bg-subtle:      #2B2922;
    --text:           #F0EEE6;
    --text-muted:     #B5AE9D;
    --text-faint:     #80796A;
    --accent:         #D97757;
    --accent-bg:      #3A2A22;
    --border:         #38352D;
    --border-strong:  #4A463C;
  }
}
```

Tailwind is configured to map these tokens (e.g. `bg-bg`, `text-text`, `border-border-strong`) so components stay readable.

**Status icons.** Filled circle for current state, plus a small overlay glyph:

| Status | Color | Glyph |
|---|---|---|
| `running` | `--status-running` | pulsing dot |
| `running-tool` | `--status-tool` | wrench |
| `awaiting-user` | `--status-waiting` | speech bubble |
| `idle` | `--status-idle` | dash |
| `errored` | `--status-error` | exclamation |
| `compacted` | `--text-faint` | refresh |

Use Lucide: `Circle`, `Wrench`, `MessageSquare`, `Minus`, `AlertCircle`, `RotateCcw`.

### 6.6 Capacitor configuration highlights

```ts
// capacitor.config.ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.augustoclaro.claudemobile",
  appName: "Claude Mobile",
  webDir: "dist",
  bundledWebRuntime: false,
  ios: {
    // NSCameraUsageDescription set in Info.plist:
    //   "Used to scan the pairing QR code shown by the Claude desktop app."
  },
  android: {
    // android.permission.CAMERA in AndroidManifest.xml
  },
  plugins: {
    BarcodeScanning: {
      // ML Kit will download model on first use; pre-bundle:
      googleBarcodeScannerModuleInstallState: "available"
    }
  }
};
export default config;
```

### 6.7 Reconnection & offline behavior

- WebSocket auto-reconnect with exponential backoff (max 30s).
- A "reconnecting…" pill in the header during downtime.
- On reconnect, phone sends `{ kind: "subscribe", sessionIds: [activeOpenSession] }` and requests a fresh `session_list`. The daemon responds with the current snapshot, not a replay of missed events. (v1.1 can add a bounded replay buffer.)
- Phone caches the last `session_list` in memory only; nothing persists across app launches in v1 except the device pairing.

---

## 7. Security model

### 7.1 Threat model

| Adversary | Has | Goal | Mitigation |
|---|---|---|---|
| Network observer | Pcap of WS traffic | Read messages | XChaCha20-Poly1305 over X25519 ECDH; all payloads encrypted |
| Malicious relay | Channel routing | Read or tamper with messages | Same encryption; relay sees only opaque ciphertext + channel ID; SAS confirms no MITM during pairing |
| QR camera shoulder-surfer | Photo of QR | Hijack pairing | QR contains an *ephemeral* pubkey valid only for the active pairing session; daemon discards `eph_sk` after handshake completes or 5min timeout |
| Lost phone | Long-term device key | Read future events | User revokes pairing from desktop menubar; daemon stops publishing to that device's channel |
| Compromised desktop | Full filesystem access | n/a — game over | Out of scope |

### 7.2 Pairing crypto in detail

```
desktop:  eph_sk_d, eph_pk_d  ← X25519 keypair
desktop:  nonce               ← 32 random bytes
QR payload (signed implicitly by being on the desktop screen):
  channel || eph_pk_d || nonce

phone:    eph_sk_p, eph_pk_p  ← X25519 keypair
phone publishes pair_hello:   eph_pk_p

shared    = X25519(eph_sk_d, eph_pk_p)   on desktop
          = X25519(eph_sk_p, eph_pk_d)   on phone

session_key  = HKDF-SHA256(
                ikm  = shared,
                salt = nonce,
                info = "claudemobile/v1/session",
                len  = 32)

sas_key      = HKDF-SHA256(
                ikm  = shared,
                salt = nonce,
                info = "claudemobile/v1/sas",
                len  = 4)
SAS words    = bip39-style 4-word encoding of sas_key
```

After SAS confirmation, both sides discard `eph_sk_*`. `session_key` is stored long-term (devices.toml on desktop, Keychain/Keystore on phone).

### 7.3 Per-message AEAD

```
nonce  = direction_byte || counter_u64 || zero_padding   // 24 bytes total
ct     = XChaCha20-Poly1305(session_key, nonce, plaintext, aad = device_id)
```

Counter is monotonic and persisted on both sides. On reconnect, both sides exchange their last-seen counter and refuse messages with non-monotonic counters (prevents replay).

### 7.4 Revocation

Desktop menubar shows paired devices with last-seen times. "Revoke" sends a `{ kind: "revoke" }` frame, deletes the entry from `devices.toml`, and stops subscribing to that channel. The phone clears its Keychain entry on receipt.

---

## 8. Status detection — full algorithm

Per session, on every JSONL line append and every 1s tick:

```
let tail = last 20 lines of session jsonl
let last = tail.last
let now  = current time

if last.type == "tool_use":
    has_result = tail.any(line => line.type == "tool_result" and
                                   line.tool_use_id == last.id)
    if not has_result:
        return ("running-tool", f"Running {last.name}…")

if last.type == "result" and (last.subtype == "error" or last.is_error):
    return ("errored", "Error")

if last.type == "summary" and exists sibling jsonl newer than this one:
    return ("compacted", "Session compacted")

if last.type == "assistant" and last.stop_reason == "end_turn":
    if now - last.ts < 5s:
        return ("running", "Finishing turn…")
    else:
        return ("awaiting-user", "Waiting for you")

if now - jsonl.mtime > 60s:
    return ("idle", None)

return ("running", "Working…")
```

Subagent sessions (`subagents/agent-*.jsonl`) are treated identically; their `parentSessionId` is parsed from the directory path. The UI nests subagents under their parent in the detail view but lists them as siblings in the main list (your call — both are reasonable; v1 nests them, v1.1 lets users toggle).

---

## 9. Sorting & list semantics

Canonical ordering rule for `SessionList`:

> Sessions are sorted by `lastUserMessageAt` descending, with `errored` sessions floated to the top of the most-recent N minutes (you probably want to look at the error).

`lastUserMessageAt` is derived in this priority order:

1. The latest entry in `~/.claude/history.jsonl` whose `project` field maps to this session's directory.
2. The latest `type: "user"` line in the session's own jsonl, if (1) doesn't apply.
3. The session's file creation time, if neither applies (very rare; only for sessions that started before the daemon was running).

Cowork desktop sessions don't write to `~/.claude/history.jsonl`, so rule (2) applies for them.

When a new user message lands, the daemon emits exactly one `session_upsert` for that session, with the updated `lastUserMessageAt`. The phone moves the row to the top with a 200ms slide animation.

---

## 10. Implementation phases

### Phase 0 — Spike (1 week)
- Rust daemon that prints session events to stdout, no networking.
- Manual verification that file watching catches all events without dropped lines.
- JSONL parser handles every event variant Claude Code emits today.

### Phase 1 — MVP (3 weeks)
- Ably relay integration.
- X25519 + XChaCha20 pairing & encryption.
- Capacitor app: scan, pair, list, detail (read-only stream).
- Menubar app with pairing UI and device list.
- Homebrew tap.
- iOS TestFlight + Android internal-testing track.

### Phase 1.5 — Polish (1 week)
- Push notifications when a session transitions to `awaiting-user` while the phone is backgrounded.
- "Quiet hours" + per-session mute.
- Onboarding screens.

### Phase 2 — App Store submission (2 weeks calendar, ~3 days work)
- Privacy manifest (iOS), data safety form (Android).
- App Store screenshots in light & dark.
- Review responses.

### Phase 3 — v1.1
- Multi-desktop support.
- Self-hosted Cloudflare Workers + Durable Objects backend as an opt-in.
- Two-way messaging.
- Bounded event replay on reconnect.

---

## 11. Repo layout

```
claude-mobile/
├─ daemon/                 # Rust
│   └─ … (see §4.2)
├─ mobile/                 # Capacitor + React
│   └─ … (see §6.2)
├─ shared/
│   ├─ wire/               # Frame / Event / Session JSON schemas (single source of truth)
│   │  └─ schema.json
│   └─ status-rules.md     # human-readable copy of §8 algorithm
├─ infra/
│   ├─ ably-setup.md       # how to provision the Ably app + scoped tokens
│   └─ cloudflare-do/      # alternative relay, future
├─ scripts/
│   └─ test-fixture-jsonl/ # captured real jsonl files for daemon tests
├─ README.md
└─ SPEC.md                 # this document
```

Wire schemas live in `shared/wire/` and are codegen'd into both Rust structs (via `typify`) and TypeScript types (via `json-schema-to-typescript`) so the daemon and phone can never drift.

---

## 12. Testing strategy

### Daemon
- Unit tests for status engine: feed it canned jsonl snippets, assert each rule fires.
- Integration tests using real jsonl captures (sanitized) from `~/.claude/projects/` checked into `scripts/test-fixture-jsonl/`.
- Property-based test (with `proptest`): replay random subsets of a real session in random chunk sizes, assert final state is invariant.

### Crypto
- Cross-implementation vectors: same plaintext + key + nonce → same ciphertext between Rust (`chacha20poly1305`) and JS (`libsodium`). Checked into CI.

### Mobile
- Component tests with Vitest for `SessionRow`, `EventBubble`, `ToolCard`.
- Detox or Maestro for end-to-end pairing flow against a local fake relay.

### Manual QA checklist
- Pair, kill desktop daemon, observe phone shows "Disconnected", restart, observe reconnect within 5s.
- Pair, lock phone for 10 min, unlock, observe state catch-up is correct (no missed transitions).
- Pair, compact a session in Claude Code, observe new session appears and old marked `compacted`.
- Pair, run a multi-subagent Task tool call, observe each subagent appears nested.
- Pair with poor cellular (Network Link Conditioner: 3G), observe reconnect-with-backoff works.

---

## 13. Cost estimate

| Item | v1 | v2 (self-host) |
|---|---|---|
| Ably (free tier covers ~10 active users) | $0 | — |
| Ably paid (Production plan) | $29/mo | — |
| Apple Developer Program | $99/yr | $99/yr |
| Google Play | $25 one-time | $25 one-time |
| Cloudflare Workers + DO | — | ~$5/mo |
| Domain | $12/yr | $12/yr |

V1 is essentially free until you exceed Ably's free tier.

---

## 14. Open questions

1. **iOS background WebSocket** — iOS suspends WebSockets aggressively in background. v1.1 push notifications are the right fix, but for v1, accept that the live stream pauses while backgrounded and resumes on resume. Document this clearly in onboarding.
2. **Subagent display** — nest under parent (v1) vs. flat list with parent indicator (v1.1)? My recommendation: nest, but allow expand-all in settings.
3. **What to render for very long assistant messages** — collapse after 800 chars with a "Show full" expander, or render full? Likely collapse.
4. **Tool result truncation** — Claude Code's tool results can be huge (e.g. full Grep output). Truncate at 4KB in the wire frame, with a "Truncated · {n} more chars on desktop" footer in the UI.
5. **What about Cowork mobile?** — A Cowork user running on macOS (like you, in this very session) has sessions in `~/Library/Application Support/Claude/local-agent-mode-sessions/`. v1 surfaces them as `source: "cowork"` but hides them behind a settings toggle since they're noisier (every Cowork tool call is a session event).

---

## 15. References

- Claude Code internals: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, `~/.claude/history.jsonl`, `~/.claude/todos/`.
- Cowork desktop session storage: `~/Library/Application Support/Claude/local-agent-mode-sessions/<install-id>/<install-id>/local_<id>/`.
- Capacitor docs: https://capacitorjs.com/docs
- ML Kit barcode scanning: https://capawesome.io/plugins/mlkit/barcode-scanning/
- Ably channels & E2EE: https://ably.com/docs/realtime/channels
- libsodium primitives: https://doc.libsodium.org/
- Cloudflare Durable Objects WebSocket Hibernation: https://developers.cloudflare.com/durable-objects/api/websockets/

---

## Appendix A — Sample wire frames

```jsonc
// Daemon → phone, after pairing
{
  "kind": "hello",
  "agentVersion": "0.1.0",
  "hostname": "augustos-mbp",
  "platform": "macos",
  "ts": 1747662000000
}

// Daemon → phone, on initial subscribe to dev:{deviceId}
{
  "kind": "session_list",
  "sessions": [
    {
      "id": "1833f353-f351-4a78-9bb4-7ad5b1edb892",
      "projectPath": "/Users/augustoclaro/ohmaseclaro/merge-factory-idle",
      "projectLabel": "ohmaseclaro / merge-factory-idle",
      "status": "running-tool",
      "lastUserMessageAt": 1747661944000,
      "lastEventAt": 1747661998200,
      "lastUserMessagePreview": "let's also handle the case where two cards merge…",
      "currentActivity": "Running Edit on src/cards/Merge.ts",
      "isSubagent": false,
      "source": "claude-code"
    },
    /* … */
  ],
  "ts": 1747662000000
}

// Daemon → phone, on every appended line
{
  "kind": "session_event",
  "event": {
    "sessionId": "1833f353-f351-4a78-9bb4-7ad5b1edb892",
    "ts": 1747661998200,
    "type": "tool_use",
    "toolName": "Edit",
    "toolUseId": "toolu_01ABC",
    "toolInput": { "file_path": "src/cards/Merge.ts", "old_string": "…", "new_string": "…" }
  }
}

// Phone → daemon, when user taps into a session
{
  "kind": "subscribe",
  "sessionIds": ["1833f353-f351-4a78-9bb4-7ad5b1edb892"]
}
```

---

## Appendix B — JSONL line types Claude Code emits

For reference when implementing `daemon/src/jsonl/parse.rs`:

- `type: "user"` — user prompt; fields: `message.content`, `cwd`, `timestamp`.
- `type: "assistant"` — assistant turn; fields: `message.content[]` (array of text + tool_use blocks), `stop_reason`, `usage`.
- `type: "tool_result"` — appears as part of a user turn's content array, not a standalone line in newer Claude Code; older versions emit standalone.
- `type: "summary"` — written when a session is auto-compacted; references the prior session's UUID.
- `type: "system"` — system warnings/reminders; can be ignored or shown with low emphasis.

The daemon should be liberal in what it accepts: parse with serde's `#[serde(other)]` catch-all variant and log unknown line types at `trace` level rather than dropping them.

---

*Spec version 1. Author: drafted for Augusto. Last revised 2026-05-19.*
