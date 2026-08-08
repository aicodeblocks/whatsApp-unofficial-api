# Milestone 2 — AI Provider Hub

You are entering plan mode to plan and then build milestone 2 of WaGuard v3.

## Context

- Read `@_build_plan/v3/prd.md` for the full project context, scope, data model, tech stack, and the cross-cutting API-first requirement.
- Read `@_build_plan/v3/milestones/1-bots-template-rules/milestone-log.md` to understand what has already been built in v3.
- The user's `opentemplatesms` project (`/Users/mahmed/Documents/CodeLibrary-M2/opentemplatesms`, see `docs/TENANT_AI_ROADMAP.md`) has a reference `AIProviderInterface` design (Claude default, OpenAI, Ollama; per-task model routing; DB-stored credentials; budget/cost containment). It is PHP — adapt the *architecture*, not the code, to this Node/TypeScript codebase. Default to the latest Claude models.

## Your task

1. Plan the implementation for **only** milestone 2 as defined in the PRD. Do not plan or build anything from later milestones (in particular, do NOT wire AI into the bot runtime yet — that is Milestone 3).
2. After the user confirms the plan, build only what is in milestone 2's scope.
3. Verify your work against the "Done when" criteria for milestone 2 in the PRD.
4. When complete, write a `milestone-log.md` in this folder (`_build_plan/v3/milestones/2-ai-provider-hub/milestone-log.md`), structured as:
   - **Start with a `## What's new in the app` section at the very top** — user-facing capabilities added, short and scannable.
   - Then: what was built (files/models/routes), decisions not pre-specified in the PRD, anything the next milestone needs, and any deviations from the PRD and why.

Ask me any clarifying questions using the AskUserQuestion tool to lock in the implementation plan for this milestone.
