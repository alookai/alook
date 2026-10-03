import { z } from "zod"
import type { Conversation, Message, Artifact } from "@alook/shared"
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)))
export const cachedConversationSchema = z.object({
  id: z.string().min(1), agent_id: z.string(), title: z.string(), type: z.string(), channel: z.string(),
  parent_message_id: z.string().nullable().optional(), thread_title: z.string().optional(),
  created_at: timestamp, message_count: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Conversation>
export const cachedMessageSchema = z.object({
  id: z.string().min(1), conversation_id: z.string().min(1), role: z.enum(["user", "assistant", "event"]),
  content: z.string(), task_id: z.string().nullable(), attachment_ids: z.array(z.string()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(), status: z.literal("active").optional(), created_at: timestamp,
}) satisfies z.ZodType<Message>
export const cachedArtifactSchema = z.object({
  id: z.string().min(1), conversation_id: z.string().min(1), agent_id: z.string(), filename: z.string(),
  content_type: z.string(), size: z.number().nonnegative(), source: z.string(), has_thumbnail: z.boolean(), created_at: timestamp,
}) satisfies z.ZodType<Artifact>
