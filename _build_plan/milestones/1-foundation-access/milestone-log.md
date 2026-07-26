# Milestone 1 — Foundation & Access · Log

## What's new in the app

- **One-command startup in Docker.** `docker compose up --build` brings up the whole service with only Docker installed on the host. A non-Docker run (`npm run dev` / `npm start`) also works.
- **First-run admin setup.** On first launch the dashboard shows a "create admin password" screen; after that you log in with that password.
- **Admin dashboard shell.** A clean, lightweight dashboard with an Overview page and a left-nav (Numbers, Send & Queue, Contacts, Webhooks, Health marked "soon"; API Tokens and API Docs live now).
- **API tokens.** Create named tokens and revoke them. Each token's value is shown once at creation. Downstream apps authenticate with `Authorization: Bearer <token>`.
- **Protected API.** A sample endpoint `GET /api/v1/status` returns 200 with a valid token and 401 without one.
- **Live API documentation.** Auto-generated interactive docs at `/docs`, plus a downloadable OpenAPI spec at `/openapi.json` that a CRM or other app can import. It grows automatically as later milestones add endpoints.
- **Data survives restarts.** The SQLite database and session secret live on the `./data` volume, so admin credentials and tokens persist across container restarts and rebuilds.

## What was built

**Stack:** Node.js + TypeScript (ESM, NodeNext), Fastify 5, better-sqlite3, EJS server-rendered views, `@fastify/swagger` + `swagger-ui`.

**Files created:**
- `package.json`, `tsconfig.json` — ESM TypeScript project. `build` compiles to `dist/` and copies `src/views` → `dist/views`.
- `Dockerfile` — multi-stage: builder (with python3/make/g++ for native `better-sqlite3`) compiles and prunes dev deps; slim runtime stage runs `node dist/server.js`. `VOLUME /app/data`, `EXPOSE 3000`.
- `docker-compose.yml` — maps `3000:3000`, `env_file: .env`, volume `./data:/app/data`, `restart: unless-stopped`.
- `.env.example`, `.dockerignore`, `.gitignore`, `README.md`.
- `src/config.ts` — env-driven config with safe defaults. Ensures `DATA_DIR` exists; resolves/persists a `SESSION_SECRET` to `data/.session-secret` if not provided.
- `src/db/index.ts` — single better-sqlite3 connection (WAL, foreign keys on), runs migrations on import.
- `src/db/migrations.ts` — idempotent schema. Tables: `app_settings` (key/value; holds admin password hash), `api_tokens`.
- `src/db/settings.ts` — `isFirstRun()`, `setAdminPassword()`, `verifyAdminPassword()` using Node `crypto.scrypt` (salt:key hex), constant-time compare.
- `src/db/tokens.ts` — `createToken()` (returns one-time plaintext `wg_<hex>`, stores only SHA-256 hash + 10-char prefix), `listTokens()`, `revokeToken()`, `verifyToken()` (updates `last_used_at`).
- `src/plugins/auth.ts` — registers `@fastify/cookie` + `@fastify/session`; decorates `requireAdmin` (redirects to `/login`) and `requireApiToken` (Bearer → 401 on missing/invalid). Wrapped with `fastify-plugin`.
- `src/plugins/swagger.ts` — OpenAPI config with `bearerAuth` security scheme; UI at `/docs`; raw spec alias at `/openapi.json`.
- `src/routes/api/system.ts` — `GET /api/v1/status` (token-protected, fully schema'd so it appears in docs).
- `src/routes/dashboard/index.ts` — `/setup`, `/login`, `/logout`, `/` (overview), `/tokens` (list/create), `/tokens/:id/revoke`.
- `src/views/` — `partials/head.ejs` + `foot.ejs` (shared shell + inline CSS, light/dark aware, `chrome: 'app'|'auth'`), `setup.ejs`, `login.ejs`, `home.ejs`, `tokens.ejs`.

**Endpoints summary:**
- Dashboard (session): `GET /setup`, `POST /setup`, `GET /login`, `POST /login`, `POST /logout`, `GET /`, `GET /tokens`, `POST /tokens`, `POST /tokens/:id/revoke`.
- API (Bearer): `GET /api/v1/status`.
- Docs: `GET /docs`, `GET /openapi.json`.

## Decisions made during implementation (not pre-specified in the PRD)

- **Admin login = first-run setup page** (per the user's choice), not an env-var password. Password is hashed with scrypt and stored in `app_settings`.
- **SQLite driver: `better-sqlite3`** (synchronous, fast, prebuilt/native). The Dockerfile's builder stage includes build tools so the native module compiles cleanly; the runtime image stays slim.
- **Sessions use the default in-memory store**, so admin *login sessions* do not survive a restart (you log in again) — but all *persistent data* (credentials, tokens) does. The signing secret is persisted so cookies remain valid config-wise.
- **Token format** `wg_` + 24 random bytes hex; only the SHA-256 hash and a short prefix are stored. Plaintext shown once.
- **API base path is `/api/v1`** — later milestones should add endpoints under this prefix and give each a schema so it auto-populates the OpenAPI docs.
- **View engine EJS** with a two-mode shared shell (`app` vs `auth`) — kept intentionally dependency-light (no frontend build step).

## Verification (all against the "Done when" criteria — passed)

Tested both non-Docker (`node dist/server.js`) and via `docker compose`:
- First-run `/login` → 302 to `/setup`; completing setup logs in and redirects to `/`.
- Unauthenticated `GET /api/v1/status` → 401; with a valid Bearer token → 200 JSON.
- Token create (shown once) and revoke → revoked token then returns 401.
- Wrong admin password rejected; correct password logs in.
- `/docs` → 200, `/openapi.json` → 200 (valid OpenAPI 3.x).
- **Restart persistence:** after `docker compose restart`, `/login` renders login (not setup), and a previously-created token still authenticates — data confirmed on the host `./data` volume.

## What the next milestone (2 — Link a Number) needs to know

- Add a `whatsapp_numbers` table in `src/db/migrations.ts` (see PRD data model) and a matching data-access module under `src/db/`.
- Baileys auth state / session files should be written under `config.dataDir` (e.g. `data/sessions/<numberId>/`) so they persist on the volume alongside the DB.
- New dashboard pages: replace the "Numbers" nav placeholder in `src/views/partials/head.ejs` with a real link/page. Follow the existing EJS shell + `requireAdmin` preHandler pattern.
- New API endpoints go under `/api/v1` with a Fastify `schema` (tags/summary/response) so they appear in `/docs` automatically. Protect them with `app.requireApiToken`.
- QR rendering: Baileys emits a QR string; render it in the dashboard (e.g. a small QR lib or data-URI) on the Numbers page.

## Deviations from the PRD

None material. The PRD allowed either env-var or first-run password; the first-run setup page was chosen. Everything else matches the Milestone 1 scope.
