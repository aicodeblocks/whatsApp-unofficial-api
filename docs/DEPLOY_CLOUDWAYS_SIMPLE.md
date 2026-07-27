# Deploying WaGuard on Cloudways — simple alternative (no Nginx reverse proxy)

The main guide ([`DEPLOY_CLOUDWAYS.md`](DEPLOY_CLOUDWAYS.md)) proxies WaGuard
through Nginx so it can sit behind your domain with a free SSL certificate —
that's the right setup for anything a downstream app or teammate will call
over the internet long-term.

If you don't need a clean domain or HTTPS right now (quick testing, an
internal tool only you or a trusted server calls, or you'd rather avoid
touching Cloudways' Nginx vhost config at all), you can skip the reverse
proxy entirely and hit the Node process directly on its own port. This is
**not a Cloudways-specific shortcut** — a reverse proxy is only needed for
port 80/443 + TLS + a clean URL. Node happily serves plain HTTP on any port
by itself, so this works on any VPS, Cloudways included.

Trade-offs vs. the main guide:

- ✅ Simpler — no Nginx vhost editing, nothing to break on a Cloudways platform update.
- ❌ No HTTPS. Traffic (including your admin login and API tokens) is
  unencrypted. Fine for `localhost`-only or trusted-network access; not fine
  for anything public.
- ❌ URL is `http://<ip-or-domain>:3000` instead of a clean `https://` domain.
- ❌ `COOKIE_SECURE` must stay `false`, since there's no TLS.

If you outgrow this, follow the "Reverse-proxy through Nginx and add SSL"
step in the main guide — everything else here (Node install, deploy, PM2) is
identical.

## Steps

1. Do steps 1–3 of the main guide: provision the server, enable SSH, install
   Node 20 + build tools, `git clone` the repo, `npm install`, `npm run build`.
2. `.env` — leave `COOKIE_SECURE=false` (the default) since there's no TLS.
   Set `PORT=3000` (or any port you like) and `PUBLIC_BASE_URL` to
   `http://<server-ip-or-domain>:3000`.
3. Start it under PM2 exactly as in the main guide:

   ```bash
   pm2 start dist/server.js --name waguard
   pm2 save
   pm2 startup systemd   # run the printed sudo command
   ```

4. Open the port in Cloudways' firewall: server → **Manage Services** /
   **Firewall Management** in the Cloudways console → open port `3000` (or
   whichever port you chose) to the internet (or restrict it to specific IPs
   if you only need to reach it from one place — recommended).
5. Visit `http://<server-ip-or-domain>:3000`.

## Automating deploys

Whichever hosting approach you use, updating requires: `git pull`, reinstall,
rebuild (`npm run build` — WaGuard is TypeScript, so this step can't be
skipped), and restart the process. `scripts/deploy.sh` in this repo does all
of that in one command — copy the project to the server once, then for every
update:

```bash
./scripts/deploy.sh
```

To trigger that automatically on every `git push` instead of running it by
hand, add a small SSH-deploy step to CI (e.g. a GitHub Actions workflow using
[`appleboy/ssh-action`](https://github.com/appleboy/ssh-action) to SSH into
the server and run `./scripts/deploy.sh` on push to `main`). Cloudways' own
Git integration (Application Settings → Git) only pulls files into the
placeholder PHP app's `public_html` and won't run `npm run build` — it isn't
useful here on its own, since this app never actually runs as that PHP app.
