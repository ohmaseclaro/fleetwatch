#!/usr/bin/env bash
# fleetwatch landing — server-side deploy script.
#
# Runs as the `deploy` user on the VPS. Pulls latest from git, syncs the
# nginx vhost from the repo template (substituting __FLEETWATCH_REPO_ROOT__),
# runs `nginx -t`, and reloads. No node service, no Docker — the landing is
# fully static.
#
# Usage:    /home/fleetwatch/deploy/update.sh
# Idempotent: safe to run repeatedly.

set -euo pipefail

REPO_ROOT="${FLEETWATCH_REPO_ROOT:-/home/fleetwatch}"
NGINX_TEMPLATE="$REPO_ROOT/deploy/nginx/fleetwatch-landing-host.conf"
NGINX_INSTALLED="/etc/nginx/sites-available/fleetwatch-landing"
NGINX_ENABLED="/etc/nginx/sites-enabled/fleetwatch-landing"

echo "→ fleetwatch deploy starting (repo=$REPO_ROOT)"

# ─── Pull latest ────────────────────────────────────────────────────────────
cd "$REPO_ROOT"
git fetch --tags origin
# `git pull --ff-only` would fail on a diverged local clone — but the deploy
# tree should never have local commits. Hard-reset to origin/main keeps it
# fast-forward AND fixes any accidental local drift.
git reset --hard origin/main

# ─── Render nginx vhost (substitute repo-root placeholder) ──────────────────
TMP_VHOST="$(mktemp)"
trap 'rm -f "$TMP_VHOST"' EXIT
sed "s|__FLEETWATCH_REPO_ROOT__|${REPO_ROOT}|g" "$NGINX_TEMPLATE" > "$TMP_VHOST"

# ─── Install + reload ───────────────────────────────────────────────────────
# `sudo` here is gated to specific commands by /etc/sudoers.d/fleetwatch (set
# up once during provisioning) — so `deploy` can install nginx vhosts and
# reload nginx without a password, and only that.
sudo install -o root -g root -m 0644 "$TMP_VHOST" "$NGINX_INSTALLED"

if [[ ! -L "$NGINX_ENABLED" ]]; then
    sudo ln -sf "$NGINX_INSTALLED" "$NGINX_ENABLED"
fi

echo "→ nginx -t"
sudo nginx -t

echo "→ reload nginx"
sudo systemctl reload nginx

# ─── Smoke check ────────────────────────────────────────────────────────────
echo "→ smoke check (loopback HTTPS, host header override)"
HTTP_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    --resolve fleetwatch.ohmaseclaro.dev:443:127.0.0.1 \
    --max-time 5 \
    https://fleetwatch.ohmaseclaro.dev/ || echo "000")
echo "   GET https://fleetwatch.ohmaseclaro.dev/ → $HTTP_STATUS"

if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "✗ smoke check failed (expected 200, got $HTTP_STATUS)" >&2
    exit 1
fi

echo "✓ fleetwatch landing deployed"
