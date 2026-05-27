import PostalMime from "postal-mime";
import { nanoid } from "nanoid";
import {
  queries,
  TASK_TYPES,
  type Database,
  type EmailNotifyRequest,
} from "@alook/shared";
import { TaskService } from "@/lib/services/task";

const TRIAGE_BODY_LIMIT = 8_000;

export type TriageEmailSummary = {
  bodyText?: string;
  bodyHtml?: string;
  attachmentSummaries?: { filename: string; type: string; size?: number }[];
};

type TriageEmailSummaryResult =
  | { ok: true; summary: TriageEmailSummary }
  | { ok: false };

type AgentForTriage = NonNullable<Awaited<ReturnType<typeof queries.agent.getAgent>>>;

function truncateForTriage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > TRIAGE_BODY_LIMIT
    ? `${trimmed.slice(0, TRIAGE_BODY_LIMIT)}\n[truncated]`
    : trimmed;
}

function attachmentSize(attachment: Record<string, unknown>): number | undefined {
  const content = attachment.content;
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return typeof attachment.size === "number" ? attachment.size : undefined;
}

function hasUsableAttachmentMetadata(summary: { filename: string; type: string }): boolean {
  return summary.filename.trim() !== "attachment" || summary.type !== "application/octet-stream";
}

function hasUsableTriageSummary(summary: TriageEmailSummary): boolean {
  return Boolean(
    summary.bodyText ||
      summary.bodyHtml ||
      summary.attachmentSummaries?.some(hasUsableAttachmentMetadata),
  );
}

export async function buildTriageEmailSummary(
  env: Pick<Env, "EMAIL_BUCKET">,
  r2Key: string,
): Promise<TriageEmailSummaryResult> {
  try {
    const object = await env.EMAIL_BUCKET.get(r2Key);
    if (!object) return { ok: false };

    const raw = await object.arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
    const summary = {
      bodyText: truncateForTriage(parsed.text),
      bodyHtml: truncateForTriage(parsed.html),
      attachmentSummaries: attachments.map((attachment) => {
        const record = attachment as Record<string, unknown>;
        return {
          filename: typeof record.filename === "string" && record.filename.trim()
            ? record.filename.trim()
            : "attachment",
          type: typeof record.mimeType === "string"
            ? record.mimeType
            : typeof record.contentType === "string"
              ? record.contentType
              : "application/octet-stream",
          size: attachmentSize(record),
        };
      }),
    };

    if (!hasUsableTriageSummary(summary)) return { ok: false };

    return { ok: true, summary };
  } catch {
    return { ok: false };
  }
}

export async function enqueueEmailTriageTask(
  db: Database,
  env: Pick<Env, "EMAIL_BUCKET">,
  input: {
    agent: AgentForTriage;
    email: { id: string };
    body: EmailNotifyRequest;
  },
) {
  if (!input.agent.ownerId) return null;

  const summaryResult = await buildTriageEmailSummary(env, input.body.r2Key);
  if (!summaryResult.ok) return null;

  const summary = summaryResult.summary;
  const conv = await queries.conversation.createConversation(db, {
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    userId: input.agent.ownerId,
    title: `Triage: ${input.body.subject}`.slice(0, 50),
    type: TASK_TYPES.EMAIL_TRIAGE,
  });

  const prompt = [
    `Triage inbound email from ${input.body.from}: ${input.body.subject}`,
    summary.bodyText ? `\nText body:\n${summary.bodyText}` : "",
    !summary.bodyText && summary.bodyHtml ? `\nHTML body:\n${summary.bodyHtml}` : "",
  ].join("");
  const taskService = new TaskService(db);
  const traceId = input.body.traceId || ("tr_" + nanoid());
  return taskService.enqueueTask(
    input.agent.id,
    conv.id,
    input.agent.workspaceId,
    prompt,
    TASK_TYPES.EMAIL_TRIAGE,
    {
      context: {
        inboundEmailId: input.email.id,
        from: input.body.from,
        to: input.body.to ?? "",
        subject: input.body.subject,
        messageId: input.body.messageId,
        inReplyTo: input.body.inReplyTo,
        references: input.body.references,
        attachments: input.body.attachments,
        ...summary,
      },
      traceId,
      parentTaskId: input.body.traceId ? (input.body.sourceTaskId || null) : null,
    },
  );
}
