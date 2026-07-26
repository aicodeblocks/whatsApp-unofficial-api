# WaGuard — Self-Hosted WhatsApp API

WaGuard is a pure, headless WhatsApp API service. It links your own existing WhatsApp number by QR (like WhatsApp Web) and exposes a token-secured API to send and receive messages, with anti-ban pacing and health monitoring as the primary design goal. It has no dependency on Meta's Cloud API, no WhatsApp Business requirement, and no third-party provider. Any downstream app (a CRM, etc.) consumes it — the CRM is a separate app, not part of this repo.

**Stack:** Node.js + TypeScript · Baileys (WhatsApp multi-device over WebSocket, no headless browser) · Fastify (with auto-generated OpenAPI/Swagger docs) · SQLite.

**Deployment:** The recommended way to run the service is a single Docker container — for ease, only Docker needs to be installed on the host (`docker compose up` brings up the whole thing), with persistent data (SQLite DB, sessions, media) on a mounted volume. A direct, non-Docker run on a host with Node.js installed is also supported as a fallback; Docker is preferred for convenience, not a hard requirement.

## `_build_plan/`

The `_build_plan/` folder contains the initial PRD and per-milestone prompts used to scaffold this codebase during its initial build-out phase. These files are **temporary** — they exist for documentation and guidance only. They are **not** functional: no code, configuration, or runtime logic in this codebase should import, reference, or depend on anything inside `_build_plan/`.

Do not treat `_build_plan/` as long-living documentation for the codebase. The codebase will evolve past the assumptions and decisions captured here. Once the initial milestones are complete, this folder is expected to be deleted.
