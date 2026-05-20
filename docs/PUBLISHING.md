# Publishing fleetwatch

## First-time setup

### 1. Verify the package name is available

```bash
npm view @ohmaseclaro/fleetwatch
# E404 means free; otherwise pick another name or use a scope (@user/fleetwatch).
```

### 2. Log into npm

```bash
npm login
npm whoami  # → your username
```

### 2a. If your account has 2FA enabled (most accounts do)

A regular login token won't be allowed to `npm publish` — you'll get
`E403 … Two-factor authentication … required`. Two ways around it:

**Per-publish OTP** — pass a fresh 6-digit code from your authenticator
app:

```bash
npm publish --access public --otp=123456
# or
./scripts/release.sh patch --otp=123456
```

**One-time setup — Automation token (recommended for releases)**:

1. https://www.npmjs.com/settings/~/tokens → **Generate New Token**
2. Pick either:
   - **Classic Token → Automation** — bypasses 2FA, scoped to all your packages
   - **Granular Access Token** — check *Bypass two-factor authentication*,
     scope to the `fleetwatch` package only
3. Save the token:
   ```bash
   npm config set //registry.npmjs.org/:_authToken=<token>
   ```
4. From now on `npm publish` works without OTP.

### 3. (Optional) Add an NPM_TOKEN for GitHub Actions

For automated publishing on git tag push:

1. Create an automation token at <https://www.npmjs.com/settings/<you>/tokens>
   (type: "Automation", grants publish).
2. Add it as a GitHub secret:
   ```
   gh secret set NPM_TOKEN --body <your-token>
   ```
3. Push a tag (`git push --tags`) — `.github/workflows/publish.yml` runs.

## Releasing a new version

Use the release script. It:
- Verifies the working tree is clean and you're on main/master
- Confirms you're logged into npm
- Runs typecheck + build
- Bumps the version
- Creates a `vX.Y.Z` commit + tag
- Publishes to npm
- Pushes to GitHub

```bash
./scripts/release.sh patch   # 0.1.0 → 0.1.1
./scripts/release.sh minor   # 0.1.0 → 0.2.0
./scripts/release.sh major   # 0.1.0 → 1.0.0
```

If you've configured `NPM_TOKEN` in GitHub, you can skip the script entirely:
just bump + tag locally and push, and the workflow publishes for you.

## What gets published

The `files` field in `package.json` whitelists exactly what ships:

- `dist/server/**` — compiled daemon JS + types
- `dist/web/**` — built PWA bundle (HTML, CSS, JS, manifest, icons)
- `README.md`
- `LICENSE`
- `.env.example`

Anything else (`src/`, `server/`, `docs/`, etc.) stays in the git repo
but is excluded from the tarball.

To preview what `npm publish` will upload:

```bash
npm pack --dry-run
```

## Post-publish checklist

- [ ] `npm view @ohmaseclaro/fleetwatch` shows the new version
- [ ] `npx @ohmaseclaro/fleetwatch@latest` runs cleanly on a machine that's never seen the package
- [ ] The web UI loads at the URL printed in the banner
- [ ] A QR scan from your phone connects successfully
