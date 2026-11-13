import { z } from "zod";

export const BOT_FEEDBACK_MAX_BYTES = 10 * 1024;
export const BOT_FEEDBACK_BODY_MAX_BYTES = BOT_FEEDBACK_MAX_BYTES * 6 + 1024;

export const BotFeedbackSchema = z.object({
  text: z.string().refine((text) => text.trim().length > 0, "Feedback must contain text")
    .refine((text) => new TextEncoder().encode(text).byteLength <= BOT_FEEDBACK_MAX_BYTES, "Feedback must be at most 10 KiB of UTF-8 text"),
}).strict();

export type BotFeedbackInput = z.infer<typeof BotFeedbackSchema>;
