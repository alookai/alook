export const MEMORY_MAINTENANCE_PROMPT = `The daemon is preparing to reset this idle session. First, clean up your memory so the next session does not inherit incorrect or outdated notes.

1. Consistency: Read memory.md and experiences. Merge duplicates and resolve conflicting notes against original decisions. Check links.
2. Facts: Verify claims, especially work progress, against the latest original records. Search the context timeline and task discussions through their latest outcomes. Correct outdated or unsupported claims; keep uncertainty explicit.
3. Learn: Use .context_timeline to find channels and threads you recently participated in. Read the full history of each recent discussion, from the initial request through the work, intermediate corrections, and any final decisions. Understand the sequence of events and why the user corrected the approach before learning first principles. Proactively record the user's guidance on communication, collaboration, and how to do work. Distill it into first principles: the underlying goals, reasons, and constraints that make the guidance reusable. Preserve its scope and source links; distinguish explicit user instructions from your own inferences. Update or remove superseded notes.
4. Durability: Keep only lasting facts, preferences, and reusable lessons or procedures. Remove task status, milestones, temporary plans, and diaries; extract a reusable lesson only when useful. Keep memory.md brief with links; put procedures, scope, and reasons in experiences. Reason from first principles: distill specific events into underlying causes, constraints, and reusable principles. Omit incidental dates and details; retain context only when it changes the principle’s validity or scope.

Edit only your own memory files. This review is internal maintenance; perform it silently. Do not proactively send the owner, users, or channels progress updates, completion notices, or details about your memory state. Communicate task-relevant results, questions, and blockers normally. If nothing needs a user-facing response, send no message.

If new work arrives, handle it first and defer nap. Otherwise, after completing the review and any needed edits, your final action is to run the following command without --handoff. Do not finish with only a written reply. This instruction authorizes that nap:

$ALOOK_CLI nap`;
