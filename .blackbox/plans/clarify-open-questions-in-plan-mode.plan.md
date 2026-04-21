# Clarify open questions during plan creation

## Goal
Enforce a process where the planning agent uses the `ask_user` tool to clarify all "Open Questions" before finalized a plan with `write_plan`. This ensures that the generated plan is actionable and matches the user's intent without assumptions.

## Affected Files
- `src/config.ts`: To update `PLAN_SYSTEM_PROMPT` with stricter instructions about using `ask_user`.

## Steps
1. **Modify PLAN_SYSTEM_PROMPT**: 
   - Update the "Clarify" step in the "Process" section of `PLAN_SYSTEM_PROMPT` in `src/config.ts`.
   - Explicitly state that if the agent identifies any "Open Questions" during research or initial analysis, it MUST call `ask_user` to resolve them before calling `write_plan`.
   - Add a rule that the "Open Questions" section in the final markdown should ideally be empty, or only contain questions that truly cannot be answered yet (e.g., waiting for external dependencies).
2. **Refine ask_user usage instructions**:
   - Emphasize that multiple questions should be handled in sequence or combined if appropriate, but the priority is resolution before planning is finished.

## Open Questions
- None.

## Test Plan
1. Enter plan mode (`/plan`).
2. Give an intentionally vague prompt (e.g., "Implement a search feature").
3. Verify that the agent calls `ask_user` to clarify what kind of search (global, file-based, etc.) instead of immediately writing a generic plan.
4. Verify that the final plan written to `.blackbox/plans/` reflects the answers provided during the clarification phase.
