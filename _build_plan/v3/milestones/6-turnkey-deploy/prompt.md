# Milestone 6 — Turnkey Cloudways Deploy

You are entering plan mode to plan and then build milestone 6 of WaGuard v3.

## Context

- Read `@_build_plan/v3/prd.md` for the full project context and this milestone's scope.
- Read the existing Cloudways deployment assets before planning: `docs/DEPLOY_CLOUDWAYS.md`, `scripts/provision-cloudways.sh`, `scripts/deploy.sh`, `scripts/stop.sh`, and the root `.htaccess`. This milestone hardens and completes that existing setup — it does not replace the Apache/.htaccess + PM2 approach.
- Read the prior v3 milestone logs so the deploy accounts for every v3 addition (new dependencies, DB migrations for the new entities, and any AI-provider `.env` bootstrap keys).
- Known real-box history worth respecting: the app previously crash-looped on genuine Node 20 (ERR_REQUIRE_ESM), and `pm2` is not on PATH in non-interactive shells (it lives under `$HOME/.waguard-npm-global/bin`). Verify the deploy path handles both.

## Your task

1. Plan the implementation for **only** milestone 6 as defined in the PRD.
2. After the user confirms the plan, build only what is in milestone 6's scope: the tracked config + hardened deploy path so a Cloudways Git deploy builds, migrates, and (re)starts under PM2 with no manual server edits, plus updated verify/troubleshoot docs.
3. Verify your work against the "Done when" criteria for milestone 6 in the PRD. Note: full verification requires the user's real Cloudways box — coordinate with them for the live-apply step and clearly flag anything that can only be confirmed there.
4. When complete, write a `milestone-log.md` in this folder (`_build_plan/v3/milestones/6-turnkey-deploy/milestone-log.md`), structured as:
   - **Start with a `## What's new in the app` section at the very top** — what the maintainer can now do differently when deploying, short and scannable.
   - Then: what was built/changed (scripts/config/docs), decisions not pre-specified in the PRD, and any deviations from the PRD and why.

Ask me any clarifying questions using the AskUserQuestion tool to lock in the implementation plan for this milestone.
