import { nanoid } from "nanoid";
import type { Database } from "../../index";
import { communityBotFeedback } from "../../feedback-schema";
import { BotFeedbackSchema, type BotFeedbackInput } from "../../../community-feedback";

export async function submitFeedback(db: Database, ownerId: string, botId: string, input: BotFeedbackInput) {
  const { text } = BotFeedbackSchema.parse(input);
  const row = { id: nanoid(), ownerId, botId, text, createdAt: new Date().toISOString() };
  await db.insert(communityBotFeedback).values(row);
  return { createdAt: row.createdAt };
}
