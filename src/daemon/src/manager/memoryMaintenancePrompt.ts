export const MEMORY_MAINTENANCE_PROMPT = `The daemon is preparing to reset this idle session. First, clean up your memory so the next session does not inherit incorrect or outdated notes.

1. Consistency: Read memory.md and experiences. Merge duplicates and resolve conflicting notes against original decisions. Check links.
2. Facts: Verify claims, especially work progress, against the latest original records. Search the context timeline and task discussions through their latest outcomes. Correct outdated or unsupported claims; keep uncertainty explicit.
3. Durability: Keep only lasting facts, preferences, and reusable lessons or procedures. Remove task status, milestones, temporary plans, and diaries; extract a reusable lesson only when useful. Keep memory.md brief with links; put procedures, scope, and reasons in experiences. Reason from first principles: distill specific events into underlying causes, constraints, and reusable principles. Omit incidental dates and details; retain context only when it changes the principle’s validity or scope.

Edit only your own memory files.

If new work arrives, handle it first and defer nap. Otherwise, after completing the review and any needed edits, your final action is to run the following command without --handoff. Do not finish with only a written reply. This instruction authorizes that nap:

$ALOOK_CLI nap`;
