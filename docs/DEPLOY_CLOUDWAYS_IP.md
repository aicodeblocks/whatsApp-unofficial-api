# Deploying WaGuard on Cloudways — IP-only (no domain, no SSL)

The main guide ([`DEPLOY_CLOUDWAYS.md`](DEPLOY_CLOUDWAYS.md)) proxies WaGuard
through Nginx so it can sit behind your domain with a free SSL certificate —
that's the right setup for anything a downstream app or teammate will call
over the internet long-term.

Use this guide instead if you don't have a domain pointed at the server yet
(or don't want to wait on DNS propagation): quick testing, an internal tool,
or access restricted to trusted IPs. WaGuard runs the same way — Node under
PM2 — it's just reached directly on its own port instead of through Nginx.
This is **not a Cloudways-specific shortcut** — a reverse proxy is only
needed for port 80/443 + TLS + a clean URL. Node happily serves plain HTTP on
any port by itself, so this works on any VPS, Cloudways included.

Trade-offs vs. the main guide:

- ✅ No domain or DNS required — works against the server's bare IP.
- ✅ No Nginx vhost editing, nothing to break on a Cloudways platform update.
- ❌ No HTTPS. Traffic (including your admin login and API tokens) is
  unencrypted. Fine for trusted-network access; not fine for anything public.
- ❌ URL is `http://<server-ip>:3000` instead of a clean `https://` domain.
- ❌ `COOKIE_SECURE` must stay `false`, since there's no TLS.

If you outgrow this, get a domain pointed at the server and switch to
`scripts/provision-cloudways.sh` / the main guide — Node install, deploy, and
PM2 setup are identical, only the Nginx/SSL step changes.

## One-shot automated setup

`scripts/provision-cloudways-ip.sh` does steps 2–4 below for you in a single
run: installs Node + build tools + PM2, builds the already-deployed app,
writes `.env` with plain-HTTP settings, and starts it under PM2 (with
boot-persistence) — logging every step to a timestamped file under
`~/waguard-provision-logs/`.

It's menu-driven, same as the main script: run it with no arguments over an
interactive SSH session and it asks whether to **dry-run** (check everything,
log what would happen, make zero changes) or **apply** (do it for real). Use
`--dry-run` / `--apply` to skip the menu (needed for non-interactive use).

It needs the code already deployed into the current directory (via Cloudways'
Git deployment — step 1 below) — no DNS or domain attachment required:

```bash
ssh <master_user>@<server_ip>
cd /home/master/applications/<app>/public_html   # wherever Cloudways deployed the code
./scripts/provision-cloudways-ip.sh --dry-run
# review the log, fix anything it flags, then:
./scripts/provision-cloudways-ip.sh --apply
```

Read the script's header comment for the environment variables it accepts
(`NODE_PORT`, `PUBLIC_IP` — both optional with sane defaults). Apply is
idempotent, so re-running it after a failed step (check the log path it
prints) picks up where it left off rather than duplicating work.

The rest of this document explains the same steps manually, for anyone who'd
rather run them by hand or needs to adapt one.

## Prerequisites

- A Cloudways account and a **PHP Application** server (any provider —
  DigitalOcean, AWS, Vultr, etc.). 1 GB RAM is enough to start; 2 GB is more
  comfortable.
- Nothing else — no domain needed for this path.

## 1. Create the server and app, deploy the code via Cloudways Git

Same as the main guide's step 1: Cloudways console → **Add Server** → PHP →
deploy this repo via **Deployment via Git**, then confirm SSH access:

```bash
ssh <master_user>@<server_ip>
cd /home/master/applications/<app>/public_html
```

## 2. Install Node.js, build tools, PM2 — build the code

Identical to the main guide's steps 2–3:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
sudo npm install -g pm2

cd /home/master/applications/<app>/public_html
npm install
npm run build
npm prune --omit=dev
```

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
PORT=3000
COOKIE_SECURE=false
PUBLIC_BASE_URL=http://<server-ip>:3000
SESSION_SECRET=<a long random string, 32+ chars>
```

`COOKIE_SECURE` must stay `false` here — there's no TLS, so a `Secure` cookie
would never be sent back by the browser and login would silently fail.

## 4. Run WaGuard under PM2

```bash
pm2 start dist/server.js --name waguard
pm2 save
pm2 startup systemd   # prints a sudo command — run exactly what it prints
```

Useful commands:

```bash
pm2 status
pm2 logs waguard
pm2 restart waguard     # after a code update
```

## 5. Open the port in Cloudways' firewall

Unlike the Nginx path (where only `127.0.0.1` needs to reach port 3000), here
the Node process itself must be reachable from wherever you're connecting
from:

Cloudways console → your server → **Manage Services** / **Firewall
Management** → open `3000` (or whichever `NODE_PORT` you chose) — either to
the internet, or restricted to specific trusted IPs (recommended, since this
mode has no encryption).

## 6. Verify

```bash
curl -I http://<server-ip>:3000
```

Then open `http://<server-ip>:3000` in a browser — you should see the
WaGuard setup screen to create the admin password on first launch (same as
the Docker/local flow described in the README).

## Automating rebuilds

Same as the main guide — `scripts/deploy.sh` does `npm install` → `npm run
build` → `npm prune --omit=dev` → `pm2 restart waguard` in one shot; run it
after every Cloudways Git deploy:

```bash
cd /home/master/applications/<app>/public_html
./scripts/deploy.sh
```

## Troubleshooting

- **Can't reach `http://<server-ip>:3000` from outside** — check the
  Cloudways firewall (step 5); the process being up isn't enough if the port
  is closed.
- **`npm install` fails compiling `better-sqlite3`** — `build-essential` and
  `python3` aren't installed (step 2), or you're on an unsupported Node ABI;
  confirm `node -v` is 20+.
- **Cookies not set / stuck on login** — `COOKIE_SECURE=true` was left set
  without TLS; set it to `false` (step 3).
- **Process doesn't survive a server reboot** — re-run `pm2 startup systemd`
  and follow the printed command exactly, then `pm2 save` again.
