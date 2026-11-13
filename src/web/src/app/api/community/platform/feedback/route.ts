import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { withAuth } from "@/lib/middleware/auth-policy";
import { BotFeedbackSchema, BOT_FEEDBACK_BODY_MAX_BYTES, BOT_FEEDBACK_MAX_BYTES, queries, readBoundedJsonRequest } from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor";
import { writeJSON } from "@/lib/middleware/helpers";

export const POST = withAuth(communityActorPolicy(), async (req, ctx) => {
  const gate = requireBot(ctx.actor);
  if (!gate.ok) return gate.response;
  const rate = await checkRateLimit(ctx.env, "community:feedback", gate.bot.ownerUserId);
  if (!rate.allowed) return NextResponse.json({
    error: "Feedback limit reached (10 submissions per owner per hour)",
    code: "RATE_LIMIT_EXCEEDED",
    hint: `Try again in ${rate.retryAfterSec} seconds.`,
  }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
  const raw = await readBoundedJsonRequest(req, BOT_FEEDBACK_BODY_MAX_BYTES);
  if (!raw.ok && raw.reason === "oversized") return writeJSON({ error: "Feedback request is too large", code: "REQUEST_TOO_LARGE" }, 413);
  if (raw.ok && typeof raw.value === "object" && raw.value !== null && "text" in raw.value
    && typeof raw.value.text === "string" && new TextEncoder().encode(raw.value.text).byteLength > BOT_FEEDBACK_MAX_BYTES) {
    return writeJSON({ error: "Feedback must be at most 10 KiB of UTF-8 text", code: "FEEDBACK_TOO_LARGE" }, 413);
  }
  const parsed = BotFeedbackSchema.safeParse(raw.ok ? raw.value : null);
  if (!parsed.success) return writeJSON({ error: "Provide non-empty feedback text only (max 10 KiB UTF-8)", code: "INVALID_FEEDBACK" }, 400);
  const result = await queries.communityFeedback.submitFeedback(getPrimaryDb(ctx.env.DB), gate.bot.ownerUserId, gate.bot.userId, parsed.data);
  return writeJSON({ kind: "bot_feedback", createdAt: result.createdAt }, 201);
});
