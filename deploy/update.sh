#!/usr/bin/env bash
# fleetwatch landing — server-side deploy script.
#
# Runs as the `deploy` user on the VPS. Pulls latest from git, picks the
# right nginx vhost template based on whether a Let's Encrypt cert exists,
# substitutes the repo-root placeholder, runs `nginx -t`, and reloads.
#
# Two template paths:
#   • cert present → deploy/nginx/fleetwatch-landing-host.conf (full HTTPS)
#   • cert missing → deploy/nginx/fleetwatch-landing-host-pre-tls.conf
#                    (HTTP-only; serves the page so finalize-tls.sh can
#                     issue the cert via the webroot ACME challenge)
#
# Idempotent: safe to run repeatedly. Used by GitHub Actions + manual.

set -euo pipefail

REPO_ROOT="${FLEETWATCH_REPO_ROOT:-/home/fleetwatch}"
NGINX_INSTALLED="/etc/nginx/sites-available/fleetwatch-landing"
NGINX_ENABLED="/etc/nginx/sites-enabled/fleetwatch-landing"
CERT_PATH="/etc/letsencrypt/live/fleetwatch.ohmaseclaro.dev/fullchain.pem"
TLS_FLAG="$REPO_ROOT/.tls-provisioned"

echo "→ fleetwatch deploy starting (repo=$REPO_ROOT)"

# ─── Working tree must already be up-to-date ────────────────────────────────
# We deliberately do NOT `git pull` inside this script — if we did, the
# script would update its own source on disk while still running the
# in-memory copy from before the pull, and any new behavior wouldn't take
# effect until the NEXT run. Instead the caller (CI workflow, or a human
# running manually) pulls first, then invokes update.sh.
cd "$REPO_ROOT"

# ─── Pick the right vhost template based on cert presence ──────────────────
# Use a durable flag file (.tls-provisioned) written by finalize-tls.sh so
# the deploy user doesn't need read access to /etc/letsencrypt. Fallback: try
# the cert path directly (works when running as root).
if [[ -f "$TLS_FLAG" ]] || [[ -f "$CERT_PATH" ]]; then
    NGINX_TEMPLATE="$REPO_ROOT/deploy/nginx/fleetwatch-landing-host.conf"
    echo "→ cert found — using full HTTPS template"
    SMOKE_PROTO="https"
    SMOKE_PORT=443
else
    NGINX_TEMPLATE="$REPO_ROOT/deploy/nginx/fleetwatch-landing-host-pre-tls.conf"
    echo "→ no cert at $CERT_PATH — using pre-TLS (HTTP-only) template"
    echo "  After DNS is live, run: sudo /home/fleetwatch/deploy/finalize-tls.sh"
    SMOKE_PROTO="http"
    SMOKE_PORT=80
fi

# ─── Render vhost (substitute repo-root placeholder) ────────────────────────
TMP_VHOST="$(mktemp)"
trap 'rm -f "$TMP_VHOST"' EXIT
sed "s|__FLEETWATCH_REPO_ROOT__|${REPO_ROOT}|g" "$NGINX_TEMPLATE" > "$TMP_VHOST"

# ─── Install + reload ───────────────────────────────────────────────────────
# `sudo` here is gated to specific commands by /etc/sudoers.d/fleetwatch.
sudo install -o root -g root -m 0644 "$TMP_VHOST" "$NGINX_INSTALLED"

if [[ ! -L "$NGINX_ENABLED" ]]; then
    sudo ln -sf "$NGINX_INSTALLED" "$NGINX_ENABLED"
fi

echo "→ nginx -t"
sudo nginx -t

echo "→ reload nginx"
sudo systemctl reload nginx

# ─── Smoke check ────────────────────────────────────────────────────────────
echo "→ smoke check (loopback ${SMOKE_PROTO^^}, host header override)"
if [[ "$SMOKE_PROTO" == "https" ]]; then
    HTTP_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
        --resolve fleetwatch.ohmaseclaro.dev:${SMOKE_PORT}:127.0.0.1 \
        --max-time 5 \
        https://fleetwatch.ohmaseclaro.dev/ || echo "000")
else
    HTTP_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H "Host: fleetwatch.ohmaseclaro.dev" \
        --max-time 5 \
        http://127.0.0.1:${SMOKE_PORT}/ || echo "000")
fi
echo "   GET ${SMOKE_PROTO}://fleetwatch.ohmaseclaro.dev/ → $HTTP_STATUS"

if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "✗ smoke check failed (expected 200, got $HTTP_STATUS)" >&2
    exit 1
fi

echo "✓ fleetwatch landing deployed (${SMOKE_PROTO})"
