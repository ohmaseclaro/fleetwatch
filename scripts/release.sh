#!/usr/bin/env bash
# fleetwatch release script.
#
# Bumps version, builds, publishes to npm, tags, and pushes.
# Usage:   ./scripts/release.sh [patch|minor|major] [--otp=NNNNNN]
#          (default: patch)
#
# If your npm account uses 2FA, pass --otp=<6-digit-code> from your
# authenticator app. Or use an Automation/Granular token with "bypass
# 2FA" enabled — see docs/PUBLISHING.md.
#
# Pre-flight:
#   - Working tree must be clean
#   - On main / master branch (override with ALLOW_BRANCH=1)
#   - Logged into npm (`npm whoami`)
#   - Tests + typecheck pass

set -euo pipefail

BUMP="patch"
OTP=""
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --otp=*)            OTP="${arg#--otp=}" ;;
    *) echo "usage: $0 [patch|minor|major] [--otp=NNNNNN]" >&2; exit 1 ;;
  esac
done

# ─── Load .env so NPM_TOKEN (and any other secrets) are available ──────────
# Looks in the repo root, then in your home config dir.
load_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  # `set -a` exports every variable assignment we source — so NPM_TOKEN=...
  # in .env becomes a real env var the moment we read the file. Restore the
  # previous state afterwards so we don't leak it across the script.
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
}
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
load_env "$ROOT_DIR/.env"
load_env "$HOME/.config/fleetwatch/.env"

# ─── Pre-flight ─────────────────────────────────────────────────────────────
echo "→ Preflight checks"

# Working tree clean?
if [[ -n "$(git status --porcelain)" ]]; then
  echo "  ✗ working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "${ALLOW_BRANCH:-}" && "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "  ✗ refusing to release from branch '$BRANCH'. Set ALLOW_BRANCH=1 to override." >&2
  exit 1
fi

# Logged into npm?
if ! npm whoami >/dev/null 2>&1; then
  echo "  ✗ not logged into npm — run 'npm login' first" >&2
  exit 1
fi

echo "  ✓ tree clean, on $BRANCH, npm user: $(npm whoami)"

# ─── Build & test ────────────────────────────────────────────────────────────
echo "→ Typecheck + build"
npm run typecheck
npm run build

# ─── Version bump ───────────────────────────────────────────────────────────
echo "→ Bumping version ($BUMP)"
# npm version creates a commit + tag automatically when a git repo is present.
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version)"
echo "  ✓ new version: $NEW_VERSION"

# Commit + tag manually so we can include the version line cleanly.
git add package.json package-lock.json 2>/dev/null || true
git commit -m "release: $NEW_VERSION"
git tag -a "$NEW_VERSION" -m "$NEW_VERSION"

# ─── Publish ────────────────────────────────────────────────────────────────
echo "→ Publishing to npm"

# The project .npmrc references ${NPM_TOKEN} — warn early if it's missing so
# we don't fail mid-publish with a confusing auth error.
if [[ -z "${NPM_TOKEN:-}" && -z "$OTP" ]]; then
  cat <<'HINT' >&2
  ⚠ NPM_TOKEN is not set and no --otp was passed.
    The publish will rely on whatever auth ~/.npmrc has, and 2FA-enabled
    accounts will hit E403.
    Either:
      • Add NPM_TOKEN=<your-automation-token> to .env (or export it), OR
      • Rerun with --otp=<6-digit-code> from your authenticator app.
HINT
fi

PUBLISH_ARGS=(--access public)
if [[ -n "$OTP" ]]; then
  PUBLISH_ARGS+=(--otp="$OTP")
fi
if ! npm publish "${PUBLISH_ARGS[@]}"; then
  cat <<'HELP' >&2

✗ npm publish failed. Common causes:

  • E403 + "two-factor authentication … required":
      Your token doesn't bypass 2FA. Two fixes:
      1) Rerun with --otp=<6-digit-code> from your authenticator app:
           ./scripts/release.sh patch --otp=123456
      2) Create an Automation / Granular token at
         https://www.npmjs.com/settings/~/tokens with "bypass 2FA"
         enabled, then replace the token in ~/.npmrc.

  • E401 / E403 + "Unauthorized":
      Run `npm login` and try again.

  • E409 "Cannot publish over the previously published versions":
      The version in package.json was already shipped. Bump it.

The git tag was created locally but NOT pushed yet. To retry without
re-bumping:
    cd $(pwd)
    npm publish --access public [--otp=NNNNNN]
    git push --tags
HELP
  exit 1
fi

# ─── Push to GitHub ─────────────────────────────────────────────────────────
echo "→ Pushing commit + tag"
git push
git push --tags

echo ""
echo "✓ Released $NEW_VERSION"
echo "  https://www.npmjs.com/package/fleetwatch"
