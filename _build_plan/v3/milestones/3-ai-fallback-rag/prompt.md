# Milestone 3 — AI Fallback (RAG)

You are entering plan mode to plan and then build milestone 3 of WaGuard v3.

## Context

- Read `@_build_plan/v3/prd.md` for the full project context, scope, data model, tech stack, and the cross-cutting API-first requirement.
- Read the prior v3 milestone logs (`@_build_plan/v3/milestones/1-bots-template-rules/milestone-log.md` and `@_build_plan/v3/milestones/2-ai-provider-hub/milestone-log.md`) to understand the bot runtime and the AI provider hub you will build on.
- Key design constraint: AI is the **paid toggle**. It only ever intercepts the off-script moment that would otherwise hit the default-case template. When AI is off, the provider errors, or the budget is exhausted, the bot must fall back to the default-case template.

## Your task

1. Plan the implementation for **only** milestone 3 as defined in the PRD. Do not plan or build anything from later milestones.
2. After the user confirms the plan, build only what is in milestone 3's scope.
3. Verify your work against the "Done when" criteria for milestone 3 in the PRD.
4. When complete, write a `milestone-log.md` in this folder (`_build_plan/v3/milestones/3-ai-fallback-rag/milestone-log.md`), structured as:
   - **Start with a `## What's new in the app` section at the very top** — user-facing capabilities added, short and scannable.
   - Then: what was built (files/models/routes), decisions not pre-specified in the PRD, anything the next milestone needs, and any deviations from the PRD and why.

Ask me any clarifying questions using the AskUserQuestion tool to lock in the implementation plan for this milestone.
