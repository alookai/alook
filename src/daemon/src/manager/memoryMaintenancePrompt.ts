import { MEMORY_REVIEW_STEPS } from "./memoryReviewPrompt.js";

export const MEMORY_MAINTENANCE_PROMPT = `The daemon is preparing to reset this idle session. First, clean up your memory so the next session does not inherit incorrect or outdated notes.

${MEMORY_REVIEW_STEPS}
6. Follow up: After completing the memory review and any needed edits, run \`$ALOOK_CLI message mark list\` and check each unfinished item's latest discussion. In the item's original channel, thread, or DM, send the relevant person a brief reminder of the remaining work and the next action needed. Skip items that are already complete or cancelled. Do not wait for replies.

Edit only your own memory files. This review is internal maintenance; perform it silently. Do not proactively send the owner, users, or channels progress updates, completion notices, or details about your memory state. The task reminders in step 6 are separate from memory-maintenance updates. Communicate task-relevant results, questions, and blockers normally. If nothing needs a user-facing response, send no message.

If new work arrives, finish it first, then resume this review. After the review, edits and task reminders, your final action must be to run \`$ALOOK_CLI commit --file <log-file>\` (or --stdin) exactly once. This saves the log and resets this idle session. Do not use --no-reset. This prompt authorizes the reset.`;
