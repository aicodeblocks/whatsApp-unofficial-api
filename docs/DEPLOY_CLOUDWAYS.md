# Deploying WaGuard on Cloudways (PHP Application server)

WaGuard is a Node.js/Fastify service, not PHP — Cloudways has no native Node.js
stack. This guide uses a **Cloudways PHP Application server** purely for the
underlying VPS it gives you (SSH access, Nginx, firewall, backups, free SSL),
and runs WaGuard as a Node process managed by [PM2](https://pm2.keymetrics.io/),
reverse-proxied through Nginx. The placeholder PHP app is never actually used.

Docker is the normal recommended way to run WaGuard (see the main
[README](../README.md)), but Cloudways PHP servers don't offer Docker, so this
follows the README's "Run without Docker" path instead.

Deployment of the *code itself* is handled by Cloudways' own Git deployment
feature (Application Settings → Git), authenticated with an SSH key you
manage there — not by anything in this guide or its scripts. This guide
covers everything Cloudways' Git deploy doesn't do for a Node app: installing
Node/PM2/Nginx-proxy/SSL, and rebuilding + restarting after each deploy.

## One-shot automated setup

`scripts/provision-cloudways.sh` does steps 2–6 below for you in a single
run: installs Node + build tools + PM2, builds the already-deployed app,
writes `.env` with the required production settings, starts it under PM2
(with boot-persistence), wires up the Nginx reverse proxy, and issues a
Let's Encrypt certificate — logging every step to a timestamped file under
`~/waguard-provision-logs/`.

It's menu-driven: run it with no arguments over an interactive SSH session
and it asks whether to **dry-run** (check everything, log what would happen,
make zero changes) or **apply** (do it for real). Use `--dry-run` / `--apply`
to skip the menu (needed for non-interactive use).

It needs the code already deployed into the current directory (via Cloudways'
Git deployment — step 1 below) plus a DNS A record and domain attachment in
place first, since none of that is reachable over SSH. Dry-run checks for all
of it and tells you exactly what's missing before you apply anything:

```bash
ssh <master_user>@<server_ip>
cd /home/master/applications/<app>/public_html   # wherever Cloudways deployed the code
DOMAIN=wa.example.com LETSENCRYPT_EMAIL=you@example.com ./scripts/provision-cloudways.sh --dry-run
# review the log, fix anything it flags, then:
DOMAIN=wa.example.com LETSENCRYPT_EMAIL=you@example.com ./scripts/provision-cloudways.sh --apply
```

Read the script's header comment for the full list of environment variables
it accepts (`NODE_PORT`, `NGINX_VHOST_PATH`, `SKIP_SSL`, etc. — all optional
with sane defaults). Apply is idempotent, so re-running it after a failed
step (check the log path it prints) picks up where it left off rather than
duplicating work.

The rest of this document explains the same steps manually, for anyone who'd
rather run them by hand or needs to adapt one.

## Prerequisites

- A Cloudways account and a **PHP Application** server (any provider — DigitalOcean,
  AWS, Vultr, etc.). 1 GB RAM is enough to start; 2 GB is more comfortable.
- A domain or subdomain you control (e.g. `wa.example.com`) pointed at the
  server's public IP (A record).

## 1. Create the server and app, deploy the code via Cloudways Git

1. Cloudways console → **Add Server** → choose **PHP** as the application, any
   provider/size. This just gives you the box; the PHP app itself is unused
   as a PHP app — it exists so you get an Nginx vhost + domain + SSL slot to
   point at the Node process instead.
2. App → **Deployment via Git** (under Application Settings): connect this
   repo (`https://github.com/aicodeblocks/whatsApp-unofficial-api.git`),
   authenticated with an SSH key added there, choose the `main` branch, and
   deploy. This puts the code in the app's `public_html`
   (`/home/master/applications/<app>/public_html`).
3. Server → **Master Credentials** tab → note the **Public IP**, **SSH
   username**, and **password** (or add your SSH public key there instead),
   then confirm SSH access:

   ```bash
   ssh <master_user>@<server_ip>
   cd /home/master/applications/<app>/public_html
   ```

To update later, redeploy from the Cloudways Git tab, then rebuild/restart
(step 3, or `./scripts/deploy.sh` — see "Automating rebuilds" below).

## 2. Install Node.js and native build tools

WaGuard needs Node 20+, and `better-sqlite3` needs a C++ toolchain to compile
its native binding at install time.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
node -v   # v20.x
npm -v
```

Install PM2 globally — it keeps the Node process alive, restarts it on crash,
and can bring it back up after a server reboot:

```bash
sudo npm install -g pm2
```

## 3. Build the code

From the app directory Cloudways deployed into (step 1):

```bash
cd /home/master/applications/<app>/public_html
npm install          # full install — the TypeScript build needs devDependencies
npm run build        # compiles src/ -> dist/, copies views
npm prune --omit=dev # drop devDependencies after building, to save space
```

## 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum, for a production deployment behind your domain:

```bash
PORT=3000
COOKIE_SECURE=true
PUBLIC_BASE_URL=https://wa.example.com
SESSION_SECRET=<a long random string, 32+ chars>
```

`COOKIE_SECURE=true` requires the site to actually be served over HTTPS (step 6)
or the admin login cookie won't be set. `PUBLIC_BASE_URL` is used to build
absolute inbound-media URLs in webhook payloads — set it to your real public
domain. See `.env.example` for the full list of optional tuning variables
(anti-ban pacing, health monitoring, webhooks).

All persistent state — SQLite DB, WhatsApp session credentials, downloaded
media — lives under `./data` relative to the project root. Nothing else needs
special handling, but never delete or recreate that folder once a number is
linked; doing so forces a re-scan of the QR code.

## 5. Run WaGuard under PM2

```bash
cd /home/master/applications/<app>/public_html
pm2 start dist/server.js --name waguard
pm2 save
pm2 startup systemd   # prints a sudo command — run exactly what it prints
```

`pm2 startup` wires PM2 itself into systemd so your saved process list (`pm2
save`) comes back up automatically after a server reboot.

Useful commands:

```bash
pm2 status              # is it running?
pm2 logs waguard        # tail logs
pm2 restart waguard     # after a code update
```

## 6. Reverse-proxy through Nginx and add SSL

Cloudways puts Nginx in front of every app. Point your domain's placeholder
PHP app's Nginx vhost at the Node process instead of PHP-FPM:

1. Cloudways console → your server → the placeholder app → **Domain Management**
   → attach `wa.example.com` as the app's domain.
2. App → **Application Settings** → look for an Nginx/vhost configuration
   editor (naming varies by Cloudways plan — sometimes "Nginx & Apache",
   sometimes an "Additional Nginx directives" box). Add a proxy block routing
   traffic to the Node process on port 3000, e.g.:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   If your Cloudways plan doesn't expose a raw vhost editor in the UI, SSH in
   and edit the app's Nginx server-block file directly (commonly under
   `/home/master/applications/<app>/conf/server.nginx` on Cloudways, included
   automatically into the main Nginx config), then `sudo service nginx reload`.
   Keep a note of this customization — a Cloudways platform update to the app
   could regenerate the default (PHP-FPM) vhost and overwrite it, in which
   case just re-apply the block above.
3. Cloudways console → app → **SSL Certificate** → issue a free Let's Encrypt
   certificate for `wa.example.com`. Cloudways handles renewal automatically.

Port 3000 only needs to be reachable from `127.0.0.1` (Nginx proxies to it
locally) — no need to open it in the Cloudways firewall.

## 7. Verify

```bash
curl -I https://wa.example.com
```

Then open `https://wa.example.com` in a browser — you should see the WaGuard
setup screen to create the admin password on first launch (same as the
Docker/local flow described in the README).

## Automating rebuilds

Cloudways' Git deployment pulls the new code, but doesn't know to run `npm
run build` or restart PM2 afterwards — that part is still on you, every
time. `scripts/deploy.sh` does `npm install` → `npm run build` → `npm prune
--omit=dev` → `pm2 restart waguard` in one shot; run it right after every
Cloudways Git deploy:

```bash
cd /home/master/applications/<app>/public_html
./scripts/deploy.sh
```

If you want that to happen automatically instead of a manual step after each
deploy, check whether your Cloudways plan exposes a **post-deployment
script** hook (Application Settings → Deployment, on newer plans) and point
it at `./scripts/deploy.sh`; if not, a cron job polling for new commits, or a
CI step that SSHes in after deploying, are the usual workarounds.

## Troubleshooting

- **502/504 from Nginx** — check `pm2 status` and `pm2 logs waguard`; the Node
  process may have crashed or not be listening on the port Nginx proxies to.
- **`npm install` fails compiling `better-sqlite3`** — `build-essential` and
  `python3` aren't installed (step 2), or you're on an unsupported Node ABI;
  confirm `node -v` is 20+.
- **Cookies not set / stuck on login** — `COOKIE_SECURE=true` but the site is
  being served over plain HTTP; finish SSL setup (step 6) first, or leave
  `COOKIE_SECURE=false` temporarily while testing over HTTP.
- **Process doesn't survive a server reboot** — re-run `pm2 startup systemd`
  and follow the printed command exactly, then `pm2 save` again.
