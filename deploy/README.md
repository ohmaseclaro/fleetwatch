# Deploying fleetwatch.ohmaseclaro.dev (+ .com → .dev redirect)

Static landing page on a VPS, behind Cloudflare. Mirrors the **Atrium**
deployment pattern: GitHub Actions SSHes to the same box and runs
`./deploy/update.sh`, which syncs the repo, installs the nginx vhost, and
reloads.

| Hostname                             | What serves it                                 |
| ------------------------------------ | ---------------------------------------------- |
| `fleetwatch.ohmaseclaro.dev`         | Static files from `deploy/landing/index.html`. |
| `fleetwatch.ohmaseclaro.com`         | 301 redirects to `.dev` (canonical hostname).  |

No node service, no Docker — the landing is fully static.

## DNS (Cloudflare)

In **both** zones (`ohmaseclaro.dev` and `ohmaseclaro.com`), add:

| Type | Name         | Content          | Proxy        |
| ---- | ------------ | ---------------- | ------------ |
| `A`  | `fleetwatch` | `167.88.42.105`  | ☁ Proxied    |

SSL mode: **Full** (or **Full (strict)**) on both zones.

## One-time server setup

1. **Clone the repo** at `/home/fleetwatch`, owned by the `deploy` user:

   ```bash
   sudo mkdir -p /home/fleetwatch
   sudo chown deploy:deploy /home/fleetwatch
   sudo -u deploy -H bash -lc \
     'git clone https://github.com/ohmaseclaro/fleetwatch.git /home/fleetwatch'
   ```

2. **TLS cert** (single cert covering both hostnames):

   ```bash
   sudo certbot certonly --nginx \
     -d fleetwatch.ohmaseclaro.dev \
     -d fleetwatch.ohmaseclaro.com
   ```

   The vhost template expects:
   - `/etc/letsencrypt/live/fleetwatch.ohmaseclaro.dev/{fullchain,privkey}.pem`
   - `/etc/letsencrypt/options-ssl-nginx.conf`
   - `/etc/letsencrypt/ssl-dhparams.pem`

3. **Passwordless sudo for `deploy`** — restricted to the commands
   `deploy/update.sh` runs. Drop a file at `/etc/sudoers.d/fleetwatch`:

   ```
   deploy ALL=(root) NOPASSWD: /usr/bin/install -o root -g root -m 0644 /tmp/* /etc/nginx/sites-available/fleetwatch-landing
   deploy ALL=(root) NOPASSWD: /usr/bin/ln -sf /etc/nginx/sites-available/fleetwatch-landing /etc/nginx/sites-enabled/fleetwatch-landing
   deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t
   deploy ALL=(root) NOPASSWD: /bin/systemctl reload nginx
   ```

   `sudo visudo -c -f /etc/sudoers.d/fleetwatch` to validate.

4. **First deploy** — after the cert exists:

   ```bash
   sudo -u deploy /home/fleetwatch/deploy/update.sh
   ```

## GitHub Actions

`.github/workflows/deploy.yml` SSHes to the VPS on every push to `main` that
touches `deploy/**`, `README.md`, or `LICENSE`, and runs
`./deploy/update.sh`. Reuses the same secret names as Atrium so you don't
need a second set:

| Secret              | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `SSH_HOST`          | VPS IP or DNS name.                              |
| `SSH_USER`          | SSH login (e.g. `deploy`).                       |
| `SSH_PRIVATE_KEY`   | Private deploy key with access to `/home/fleetwatch`. |

## Manual deploy

```bash
ssh deploy@<vps>
cd /home/fleetwatch && ./deploy/update.sh
```

## Smoke checks

```bash
# Loopback (skips Cloudflare):
curl -sS -o /dev/null -w "%{http_code}\n" \
  --resolve fleetwatch.ohmaseclaro.dev:443:127.0.0.1 \
  https://fleetwatch.ohmaseclaro.dev/

# Through Cloudflare:
curl -sS -o /dev/null -w "%{http_code}\n" https://fleetwatch.ohmaseclaro.dev/

# .com → .dev redirect:
curl -sSI https://fleetwatch.ohmaseclaro.com/ | head -2
# expect: HTTP/2 301 + location: https://fleetwatch.ohmaseclaro.dev/
```

## Files in this directory

| File                                       | Installed as                                          |
| ------------------------------------------ | ----------------------------------------------------- |
| `landing/index.html`                       | Served from `/home/fleetwatch/deploy/landing/` by nginx |
| `landing/img/*`                            | Same dir (immutable cache via `/img/`)                |
| `nginx/fleetwatch-landing-host.conf`       | `/etc/nginx/sites-available/fleetwatch-landing`       |
| `update.sh`                                | Run by deploy user; no install location               |
