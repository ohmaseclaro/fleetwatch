# fleetwatch

> Watch every Claude Code, Cowork, and Cursor session from your phone — live.

[![npm version](https://img.shields.io/npm/v/@ohmaseclaro/fleetwatch.svg?color=D97757)](https://www.npmjs.com/package/@ohmaseclaro/fleetwatch)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-3C873A.svg)](https://nodejs.org)

A single command turns your laptop into a live dashboard for every AI coding
agent running on it. Pair your phone via QR code (or open from anywhere via
free ngrok tunnel) and watch sessions stream in real time — message-by-message,
tool-call-by-tool-call, screenshot-by-screenshot.

```bash
npx @ohmaseclaro/fleetwatch
```

That's the entire setup. No accounts, no signup, no config. Auto-discovers
Claude Code, Cowork, and Cursor data wherever you've installed them.

---

## What you see

```text
  fleetwatch  v0.1.2
  ─────────────────────────────────────────

  Open this on your phone (works anywhere — via ngrok):

     https://given-relapsing-plop.ngrok-free.dev/?token=HWRfx3wlwTrlS8ALSsA2nEuP9Gfv1M8l

  Or scan the QR code below:

 ▄▄▄▄▄▄▄ ▄   ▄▄   ▄▄▄  ▄  ▄▄▄▄ ▄▄▄▄▄▄▄
 █ ▄▄▄ █   █▀ ▄  ▀██▀ ▄▄▄█▀▄ ▀ █ ▄▄▄ █
 █ ███ █ █ ████▀▀▄ ▄▀   ▄▀▀███ █ ███ █
 █▄▄▄▄▄█ █▀█ ▄▀█▀▄▀▄▀▄▀▄ ▄▀▄ ▄ █▄▄▄▄▄█
 ▄   ▄ ▄▄█▄▀▀▀█▀█ █▀▀▀█▄██   █▄▄▄▄▄  ▄
 ▄  █▄▄▄▄▀ █▄  ▄ ███ ▀█▀▄▄ ▄█▀ ▀▄▀▀▀▀
 ██▀▀▀█▄▀▀█ ▀ █ ▄ █▀▄▄██▀▄   █▄██▀▄██▄
 ▀█▀▀▄▄▄▄▄ ▀█▄  ██ █   ▄█████▀▄▄▄██▄█
 █▄█▄▄▄▄██▀ ▀▀▄▀▀ █ █ ▀▄ █▄▀█▄█▄▀▀▄█▄▀
 ▀▄█ ▀▀▄▀▀█  ▀▄▄▄▄ ▄▀▄▀ ▄ ▀ █▄██▀██▄▀
   ▄██▄▄▀▀  ▄█▄▀█ █ ▄▀█▄█▄ ▀█▀▄▄█▀ █▀
 █▀▀█ █▄▄  █▄ █ ██ ▄ ▄▄██ ▀▄█▄▀ ██▄▄▄
 █ █  ▀▄██ ▄▄ ▀▄▄ █▄█▀█ ▄▀  ▄▄▄██▀▄███
 ▀▀▀█▀▀▄▀ ▀▄▀▀▄▄██   ▄▄███▀ ██▀▀▄▀▀▀
 ▄▄▄██▀▄██▀▄▀▄ ██▀█ ▄██▀ ▄   ▄███▄ █ █
 ▄▄▄▄▄▄▄ █▀█▄▄ ▀█ ▄▀   ▄█▄█  █ ▄ █  ▀
 █ ▄▄▄ █ ▄  ▄▀▄█▀▄▀▀▀████    █▄▄▄███▄▄
 █ ███ █  ▄▀ ▀▀██ ▄█▀ ▀ ▄ █▀▀▄██▀  ▀▀▀
 █▄▄▄▄▄█ ▄▄▀█ ███ █▀▀█████ ▀█ ▀ ▄▀ ██▄
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀

  Host:    YA-MN9RV4054G
  Port:    7878
  Tunnel:  https://given-relapsing-plop.ngrok-free.dev   (token via ngrok.yml (~/Library/Application Support/ngrok/ngrok.yml))
  Auth:    pairing token only (set PASSWORD to add a password)
  Cowork:  off (toggle in Settings)

  Press Ctrl+C to stop.
```

Scan the QR or paste the URL into your phone's browser. You'll see every
session sorted by most-recent activity, with live status (running / waiting /
errored / idle), source icons (Claude / Cowork / Cursor), and message-level
streaming as the agents work.

---

## Features

- **Three providers, auto-discovered**
  - Claude Code (`~/.claude/projects/*.jsonl`)
  - Cowork (`~/Library/Application Support/Claude/local-agent-mode-sessions/`)
  - Cursor IDE (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`)
- **Filterable tabs** — All / Claude / Cowork / Cursor, each with a brand icon
- **Live streaming** — WebSocket; events arrive on your phone within
  milliseconds of being written
- **Image attachments** — screenshots from the screenshot tool, user-pasted
  images render inline with a tap-to-zoom lightbox
- **Session info modal** — tap (i) on any session to see the full transcript
  path, project, git branch, session ID, file size, with copy-to-clipboard
- **Auto ngrok tunnel** — works on any network when you have a free authtoken;
  auto-picks it up from existing `~/.../ngrok.yml` if you've run
  `ngrok config add-authtoken …` before
- **Optional password gate** — set `PASSWORD=…` in `.env` to require a
  password before any device can connect (bcrypt-hashed in memory, never on
  disk)
- **JWT auth** — 30-day tokens issued on login; WebSocket and attachment
  endpoints all authed
- **Read-only by design** — never writes to source data; opens DBs read-only;
  never follows symlinks during discovery; respects file inodes for safe
  rotation
- **Robust file discovery** — env var → known paths → bounded filesystem
  search, with mandatory verify predicates so VSCode's `state.vscdb` never
  gets mistaken for Cursor's

---

## Install

### Run without installing (recommended)

```bash
npx @ohmaseclaro/fleetwatch
```

> ⚠ If you're hacking on the fleetwatch source itself, run `npm start` or
> `node dist/server/index.js` from the repo — running `npx` from inside the
> repo will collide with the in-repo `package.json` and fail with
> `command not found`.

### Install globally

```bash
npm install -g @ohmaseclaro/fleetwatch
fleetwatch
```

After global install, the `fleetwatch` command is on your PATH.

---

## ngrok setup (optional — for access from anywhere)

By default fleetwatch only works on the same Wi-Fi as your laptop. To reach
it from cellular, coffee shops, anywhere — start ngrok automatically:

1. **Sign up free** (no credit card): <https://dashboard.ngrok.com/signup>
2. **Copy your authtoken**: <https://dashboard.ngrok.com/get-started/your-authtoken>
3. **Run with the token**:

   ```bash
   fleetwatch --ngrok-authtoken <your-token>
   ```

   The token is persisted to `~/.config/fleetwatch/config.json` so future
   runs Just Work.

Already ran `ngrok config add-authtoken …` for another project? Fleetwatch
finds it automatically — zero extra config.

---

## Password protection (recommended with ngrok)

Once you put a tunnel on the public internet, anyone with the URL can
connect. Add a password:

```bash
echo 'PASSWORD=correct horse battery staple' >> .env
fleetwatch
```

Or use the **Password protection** section of the Settings screen in the UI
(visible only from the desktop, not the phone). Devices must enter the
password before connecting; bcrypt hash lives in memory only.

After successful login the client gets a 30-day JWT and the pairing token
is no longer used — the QR URL can leak without compromising the daemon.

---

## Configuration

All env vars are optional. Defaults work out of the box.

| Env var | Description |
|---|---|
| `NGROK_AUTHTOKEN` | ngrok free-tier authtoken. Enables the public tunnel. |
| `NGROK_DISABLED=1` | Skip the ngrok tunnel even if a token is available. |
| `CURSOR_DISABLED=1` | Skip the Cursor provider entirely. |
| `PASSWORD` | Optional password — required to connect when set. Bcrypt-hashed in memory only. |
| `JWT_SECRET` | JWT signing secret (auto-generated and persisted if not set). |
| `CLAUDE_PROJECTS_DIR` | Override Claude Code projects dir. |
| `COWORK_DIR` | Override Cowork sessions dir. |
| `CLAUDE_HISTORY_FILE` | Override `history.jsonl` path. |
| `CURSOR_DB_PATH` | Override Cursor `state.vscdb` path. |
| `PORT` | Override default port (`7878`). |
| `HOST` | Override default bind address (`0.0.0.0`). |

`.env` files are read from `./.env` then `~/.config/fleetwatch/.env`.
Shell env always wins.

### CLI flags

```
fleetwatch [options]

  --port, -p <port>       Port to listen on (default 7878)
  --host <host>           Bind address (default 0.0.0.0)
  --quiet, -q             Suppress QR / banner output
  --ngrok-authtoken <t>   ngrok authtoken (persisted to config)
  --no-ngrok              Disable ngrok for THIS run only (ephemeral)
  --ngrok                 Force-enable ngrok, overriding stored config
  --reset-ngrok           Clear the persisted "ngrok disabled" flag
  --no-cursor             Skip the Cursor IDE provider
  --help, -h              Show help
```

---

## Providers

Each "provider" surfaces sessions from one source. Discovery is robust —
every provider tries the default path, then OS-specific alternatives, then
a bounded filesystem search, with a `verify()` predicate that confirms
the candidate is actually that provider's data.

| Provider | Discovers | Format |
|---|---|---|
| **Claude Code** | `~/.claude/projects/*.jsonl` (plus `$CLAUDE_PROJECTS_DIR`, XDG dirs, fallback search) | Append-only JSONL |
| **Cowork** | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | Append-only JSONL (same schema as Claude Code) |
| **Cursor** | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (plus Linux/Windows paths) | SQLite, read-only |

### Adding a new provider

Aider? Continue? GitHub Copilot Chat? Custom internal agents? Extending
fleetwatch with a new source is intentionally small: declare a
`ProviderInfo`, declare a `DiscoverySpec`, implement `onStart` /
`backfillSession`.

Full guide: [`docs/ADD_A_PROVIDER.md`](docs/ADD_A_PROVIDER.md)

---

## Security

- All HTTP and WebSocket endpoints require auth (pairing token OR JWT).
- Image attachments served from content-addressed (sha256) URLs — no
  enumeration possible.
- Daemon is **read-only**:
  - JSONL files opened with append-only tailing (rotation-safe via inode)
  - SQLite opened with `readonly: true` + `fileMustExist: true`
  - Never follows symlinks during discovery
- No telemetry. No external network calls except ngrok (when enabled).
- All state lives in `~/.config/fleetwatch/` — a single JSON file.

---

## Development

```bash
git clone https://github.com/ohmaseclaro/fleetwatch
cd fleetwatch
npm install

# In one terminal: Vite HMR for the PWA
npm run dev:web

# In another: daemon in watch mode
npm run dev:server
```

Production build:

```bash
npm run build
npm start                                    # serves built bundle on :7878
```

---

## Releasing

[`scripts/release.sh`](scripts/release.sh) handles everything:

```bash
./scripts/release.sh patch        # 0.1.2 → 0.1.3
./scripts/release.sh minor        # 0.1.2 → 0.2.0
./scripts/release.sh major        # 0.1.2 → 1.0.0
./scripts/release.sh patch --otp=123456   # if 2FA is enforced
```

The script:
- verifies clean tree + on `main`/`master`
- runs typecheck + build
- bumps the version
- creates a `vX.Y.Z` commit + tag
- publishes to npm (token from `.env` via project `.npmrc`)
- pushes to GitHub

First-time setup: [`docs/PUBLISHING.md`](docs/PUBLISHING.md).

---

## License

[MIT](LICENSE) © Augusto Claro
