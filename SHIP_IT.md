# Ship `fleetwatch` v0.1.0 to npm

Everything's built, tested, and packaged. Three commands ship it.

## Pre-flight (you're here)

- [x] `fleetwatch` is available on npm (confirmed via `npm view`)
- [x] Tarball validated (114 KB, 27 files, only `dist/` + docs)
- [x] Installed-from-tarball end-to-end test passes — `fleetwatch --help`
      runs, daemon boots, discovers Claude + Cowork, serves `/api/health`
- [x] All UI brand strings say `fleetwatch` (title, manifest, banner,
      help text, Settings footer)
- [x] Legacy `~/.config/claude-watcher/` is auto-migrated to
      `~/.config/fleetwatch/` on first run so your existing JWT/token
      survive

## Ship it (your turn — needs an npm token with 2FA bypass)

Because your npm account has 2FA, you need an **Automation** or
**Granular** token that bypasses 2FA — your normal login token won't
work for `npm publish`.

```bash
# 1. Create a publish token (one-time, in your browser):
#    https://www.npmjs.com/settings/~/tokens
#    → Generate New Token → "Classic → Automation"
#      (or "Granular Access Token" → check "Bypass two-factor authentication")

# 2. Add it to .env in this repo (replaces the placeholder):
#    NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 3. Publish using the release script (sources .env automatically):
cd /Users/augustoclaro/ohmaseclaro/claude-watcher
./scripts/release.sh patch
```

Or, if you'd rather not bump the version yet (we're at 0.1.0), just:

```bash
# Source .env once in your shell so NPM_TOKEN is available
set -a; source .env; set +a
npm publish --access public
```

The project's `.npmrc` references `${NPM_TOKEN}` so `npm publish`
substitutes the value from your environment at publish time. The
token never ends up in any committed file.

That's it. `npm publish` runs `prepublishOnly` (typecheck + build) so
you can't ship a broken build by accident.

## Verify the published package

```bash
# Should show the new version
npm view @ohmaseclaro/fleetwatch

# Test on a clean machine (or a temp dir)
npx @ohmaseclaro/fleetwatch@latest --help

# Run it for real
npx @ohmaseclaro/fleetwatch@latest
```

## Push to GitHub

The repo URL in `package.json` is `github.com/ohmaseclaro/fleetwatch`.
Create the repo:

```bash
gh repo create ohmaseclaro/fleetwatch \
  --public \
  --description "Watch every Claude Code, Cowork, and Cursor session from your phone — live." \
  --source=. --remote=origin --push
```

Or via the GitHub web UI, then:

```bash
git remote add origin git@github.com:ohmaseclaro/fleetwatch.git
git push -u origin main
```

## Auto-publish on tag (optional)

`.github/workflows/publish.yml` is wired up. To use it:

1. Create an Automation token at
   <https://www.npmjs.com/settings/<you>/tokens> (type: "Automation").
2. Add to GitHub secrets:
   ```bash
   gh secret set NPM_TOKEN --body <your-token>
   ```
3. From now on, pushing a `v*` tag triggers publish:
   ```bash
   git tag v0.1.1
   git push --tags
   ```

Or use the local release script which does it all in one step:

```bash
./scripts/release.sh patch   # 0.1.0 → 0.1.1
./scripts/release.sh minor   # 0.1.0 → 0.2.0
```

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for more.

## What's in the box

Three providers, ready to use:
- **Claude Code** — `~/.claude/projects/*.jsonl` (auto-discovered)
- **Cowork** — `~/Library/Application Support/Claude/local-agent-mode-sessions/` (auto-discovered)
- **Cursor** — `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (auto-discovered, only if Cursor is installed)

Plus:
- Mobile-friendly PWA with source tabs (Claude / Cowork / Cursor icons)
- ngrok auto-tunnel (picks up `~/.../ngrok.yml` automatically)
- Optional bcrypt-hashed password gate
- JWT auth (30-day, persisted via discovered config path)
- Image attachments (user-pasted + screenshot-tool outputs) with lightbox
- Session info modal showing the exact transcript path
- Robust file discovery (env override → known paths → bounded filesystem
  search with verify predicates)

## Adding a new provider later

Read [docs/ADD_A_PROVIDER.md](docs/ADD_A_PROVIDER.md). Five-step recipe.
The abstraction (BaseProvider + DiscoverySpec) is designed for this.
