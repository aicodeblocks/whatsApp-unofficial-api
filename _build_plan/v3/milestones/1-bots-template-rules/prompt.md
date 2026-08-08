# Milestone 1 — Bots & Template Rules

You are entering plan mode to plan and then build milestone 1 of WaGuard v3.

## Context

- Read `@_build_plan/v3/prd.md` for the full project context, scope, data model, tech stack, and the cross-cutting API-first requirement.
- This is the first v3 milestone, but it builds on a fully shipped v1 + v2 codebase. Before planning, review how existing features are structured (the template library, the anti-ban send queue, inbound capture, the consent/health engine, and the EJS dashboard shell) so this milestone extends them rather than reinventing them. The v1/v2 milestone logs live in `@_build_plan/milestones/` and `@_build_plan/v2/milestones/`.

## Your task

1. Plan the implementation for **only** milestone 1 as defined in the PRD. Do not plan or build anything from later milestones.
2. After the user confirms the plan, build only what is in milestone 1's scope.
3. Verify your work against the "Done when" criteria for milestone 1 in the PRD.
4. When complete, write a `milestone-log.md` in this folder (`_build_plan/v3/milestones/1-bots-template-rules/milestone-log.md`). Structure it as follows:
   - **Start with a `## What's new in the app` section at the very top.** A concise, human-readable, bulleted list of the main user-facing features added in this milestone — framed as capabilities the user will now see or be able to do, not technical artifacts. Short and scannable.
   - Then include the implementation detail sections for the next milestone's agent to reference:
     - What was built (files created, models added, routes added, etc.)
     - Any decisions made during implementation that weren't pre-specified in the PRD
     - Anything the next milestone will need to know
     - Any deviations from the PRD and why

Ask me any clarifying questions using the AskUserQuestion tool to lock in the implementation plan for this milestone.
