# Deploying WaGuard on Cloudways (PHP Application server)

WaGuard is a Node.js/Fastify service, not PHP — Cloudways has no native Node.js
stack. This guide uses a **Cloudways PHP Application server** purely for the
underlying VPS it gives you (SSH access, Apache, firewall, backups, free SSL),
and runs WaGuard as a Node process managed by [PM2](https://pm2.keymetrics.io/),
reverse-proxied through Apache via `.htaccess`. The placeholder PHP app is
never actually used.

This follows Cloudways' own guidance for hosting a Node.js app on a PHP
server: [How to Host a Node.js Application](https://www.cloudways.com/blog/how-to-host-a-node-js-application/).
The one addition here is automation — a script that does the setup that
guide walks through by hand, plus production-specific `.env` config,
build steps, and dry-run validation.

Docker is the normal recommended way to run WaGuard (see the main
[README](../README.md)), but Cloudways PHP servers don't offer Docker, so this
follows the README's "Run without Docker" path instead.

Deployment of the *code itself* is handled by Cloudways' own Git deployment
feature (Application Settings → Git), authenticated with an SSH key you
manage there — not by anything in this guide or its script. This guide
covers everything Cloudways' Git deploy doesn't do for a Node app: installing
Node/PM2, and rebuilding + restarting after each deploy. The reverse proxy
itself (`.htaccess`, at the repo root) *is* part of the deployed code, so it
just arrives with every Git deploy — nothing to configure by hand.

## No domain required

Every Cloudways app gets a working **Application URL** out of the box
(`console → Application → Access Details`), already served over HTTPS with a
Cloudways-managed certificate — no DNS, no certbot, no waiting. That's enough
to reach WaGuard immediately after setup. Attaching your own domain later is
a one-click change in the console (Domain Management + SSL Certificate
tabs) — this guide and its script don't need to know about it either way.

## One-shot automated setup

`scripts/provision-cloudways.sh` does steps 2–5 below for you in a single
run: installs Node + build tools, installs PM2 under the master user's home
directory (no root needed for that part — same approach as Cloudways' own
guide), builds the already-deployed app, writes `.env`, and starts it under
PM2 (with boot-persistence where sudo is available) — logging every step to
a timestamped file under `~/waguard-provision-logs/`.

It's menu-driven: run it with no arguments over an interactive SSH session
and it asks whether to **dry-run** (check everything, log what would happen,
make zero changes) or **apply** (do it for real). Use `--dry-run` / `--apply`
to skip the menu (needed for non-interactive use).

It needs the code already deployed into the current directory (via Cloudways'
Git deployment — step 1 below); nothing else is required first:

```bash
ssh <master_user>@<server_ip>
cd /home/master/applications/<app>/public_html   # wherever Cloudways deployed the code
./scripts/provision-cloudways.sh --dry-run
# review the log, fix anything it flags, then:
./scripts/provision-cloudways.sh --apply
```

Once you know your app's URL (the Cloudways Application URL, or your own
domain once attached), set `PUBLIC_BASE_URL` so webhook payloads build
correct absolute media URLs, and re-run:

```bash
PUBLIC_BASE_URL=https://your-app-xxxxx.cloudwaysapps.com ./scripts/provision-cloudways.sh --apply
```

Setting `PUBLIC_BASE_URL` to an `https://` URL also flips `COOKIE_SECURE=true`
automatically (override with `COOKIE_SECURE=` explicitly if you ever need
to). Read the script's header comment for the full list of environment
variables it accepts (`NODE_PORT`, etc. — all optional with sane defaults).
Apply is idempotent, so re-running it after a failed step (check the log path
it prints) picks up where it left off rather than duplicating work.

The rest of this document explains the same steps manually, for anyone who'd
rather run them by hand or needs to adapt one.

## Prerequisites

- A Cloudways account and a **PHP Application** server (any provider — DigitalOcean,
  AWS, Vultr, etc.). 1 GB RAM is enough to start; 2 GB is more comfortable.
- That's it — no domain needed to get started (see above).

## 1. Create the server and app, deploy the code via Cloudways Git

1. Cloudways console → **Add Server** → choose **PHP** as the application, any
   provider/size. This just gives you the box; the PHP app itself is unused
   as a PHP app — it exists so you get an Apache vhost + Application URL +
   SSL slot to point at the Node process instead.
2. App → **Deployment via Git** (under Application Settings): connect this
   repo (`https://github.com/aicodeblocks/whatsApp-unofficial-api.git`),
   authenticated with an SSH key added there, choose the `main` branch, and
   deploy. This puts the code — including the root `.htaccess` — in the
   app's `public_html` (`/home/master/applications/<app>/public_html`).
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

## 3. Install PM2 (no root needed)

Following [Cloudways' own guide](https://www.cloudways.com/blog/how-to-host-a-node-js-application/),
install PM2 under the master user's home directory instead of globally —
keeps the process manager independent of whatever sudo access you have:

```bash
npm config set prefix "$HOME/.waguard-npm-global"
npm install -g pm2
echo 'export PATH="$PATH:'"$HOME"'/.waguard-npm-global/bin"' >> ~/.bashrc
source ~/.bashrc
pm2 -v
```

## 4. Build the code and configure environment

From the app directory Cloudways deployed into (step 1):

```bash
cd /home/master/applications/<app>/public_html
npm install          # full install — the TypeScript build needs devDependencies
npm run build        # compiles src/ -> dist/, copies views
npm prune --omit=dev # drop devDependencies after building, to save space

cp .env.example .env
```

Edit `.env`:

```bash
PORT=3000
COOKIE_SECURE=true
PUBLIC_BASE_URL=https://your-app-xxxxx.cloudwaysapps.com   # or your own domain
SESSION_SECRET=<a long random string, 32+ chars>
```

`COOKIE_SECURE=true` requires the site to actually be served over HTTPS,
which the default Cloudways Application URL already is — set it to `false`
only if you're testing over plain `http://127.0.0.1:3000` directly. See
`.env.example` for the full list of optional tuning variables (anti-ban
pacing, health monitoring, webhooks).

All persistent state — SQLite DB, WhatsApp session credentials, downloaded
media — lives under `./data` relative to the project root. Nothing else needs
special handling, but never delete or recreate that folder once a number is
linked; doing so forces a re-scan of the QR code.

## 5. Run WaGuard under PM2

```bash
pm2 start dist/server.js --name waguard
pm2 save
pm2 startup systemd   # prints a sudo command — run exactly what it prints (needs sudo)
```

`pm2 startup` wires PM2 itself into systemd so your saved process list (`pm2
save`) comes back up automatically after a server reboot. Skip it if you
don't have sudo access — everything else still works, it just won't survive
a reboot unattended.

Useful commands:

```bash
pm2 status              # is it running?
pm2 logs waguard        # tail logs
pm2 restart waguard     # after a code update
```

## 6. Reverse proxy (already deployed — nothing to do)

The repo's root `.htaccess` routes all incoming Apache traffic to the Node
process on port 3000 via `mod_proxy`. Since it's a tracked file, it deploys
automatically with every Cloudways Git deploy — no manual Nginx/Apache config
editing, and nothing that a Cloudways platform update can silently wipe.

It needs `mod_proxy` and `mod_proxy_http` enabled on the server. If the app
502s/500s through the Application URL but responds fine on
`http://127.0.0.1:3000` directly, that's almost certainly it — contact
Cloudways support and ask them to enable both (per their own guide, linked
above); this isn't something reachable over SSH.

If you ever change `NODE_PORT` away from the default `3000`, update the port
in `.htaccess` to match and redeploy.

## 7. Verify

```bash
curl -I https://your-app-xxxxx.cloudwaysapps.com
```

Then open that URL in a browser — you should see the WaGuard setup screen to
create the admin password on first launch (same as the Docker/local flow
described in the README).

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

- **502/500 through the Application URL, but `http://127.0.0.1:3000` works
  directly** — `mod_proxy` / `mod_proxy_http` aren't enabled; ask Cloudways
  support to enable them (see step 6).
- **`npm install` fails compiling `better-sqlite3`** — `build-essential` and
  `python3` aren't installed (step 2), or you're on an unsupported Node ABI;
  confirm `node -v` is 20+.
- **Cookies not set / stuck on login** — `COOKIE_SECURE=true` but the site is
  being served over plain HTTP; use the Cloudways Application URL (HTTPS by
  default), or set `COOKIE_SECURE=false` temporarily while testing over HTTP.
- **Process doesn't survive a server reboot** — re-run `pm2 startup systemd`
  and follow the printed command exactly (needs sudo), then `pm2 save` again.
- **API calls from a downstream app** — these use a `Bearer <token>` in the
  `Authorization` header, not a cookie, so they work over plain HTTP too;
  `COOKIE_SECURE` only affects the admin *web portal* login.
