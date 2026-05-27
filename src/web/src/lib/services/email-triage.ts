import {
  EmailTriageResultSchema,
  queries,
  toAlookAddress,
  type Database,
} from "@alook/shared";

export type EmailTriageParseResult =
  | { ok: true; decision: "untrust" }
  | { ok: true; decision: "draft_reply"; draft: { subject: string; htmlBody: string } }
  | { ok: false };

export type EmailTriageApplyResult =
  | { applied: true; decision: "untrust" }
  | { applied: true; decision: "draft_reply"; draftEmailId: string }
  | { applied: false; cleanupError?: string };

function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function parseEmailTriageOutput(raw: string): EmailTriageParseResult {
  const payload = extractJsonPayload(raw);
  if (payload == null) return { ok: false };

  const parsed = EmailTriageResultSchema.safeParse(payload);
  if (!parsed.success) return { ok: false };

  if (parsed.data.decision === "untrust") {
    return { ok: true, decision: "untrust" };
  }

  return {
    ok: true,
    decision: "draft_reply",
    draft: parsed.data.draft,
  };
}

function resolveAgentFromAddress(agent: { emailHandle?: string | null }): string | null {
  if (!agent.emailHandle) return null;
  return toAlookAddress(agent.emailHandle);
}

export async function applyEmailTriageResult(
  db: Database,
  workspaceId: string,
  agentId: string,
  inboundEmailId: string,
  parsed: EmailTriageParseResult,
): Promise<EmailTriageApplyResult> {
  if (!parsed.ok) return { applied: false };

  const inbound = await queries.email.getInboundDraftEmailForAgent(db, {
    inboundEmailId,
    agentId,
    workspaceId,
  });
  if (!inbound) return { applied: false };

  if (parsed.decision === "untrust") {
    const archived = await queries.email.archiveInboundDraftAsUntrust(db, {
      inboundEmailId,
      agentId,
      workspaceId,
    });
    return archived
      ? { applied: true, decision: "untrust" }
      : { applied: false };
  }

  const agent = await queries.agent.getAgent(db, agentId, workspaceId);
  const fromEmail = agent ? resolveAgentFromAddress(agent) : null;
  if (!fromEmail) return { applied: false };

  const references = [inbound.references, inbound.messageId].filter(Boolean).join(" ").trim();
  const result = await queries.email.promoteInboundWithDraftReply(db, {
    inboundEmailId,
    agentId,
    workspaceId,
    draft: {
      fromEmail,
      toEmail: inbound.fromEmail,
      subject: parsed.draft.subject,
      htmlBody: parsed.draft.htmlBody,
      inReplyTo: inbound.messageId || "",
      references,
    },
  });

  if (!result.applied) {
    return result.cleanupError
      ? { applied: false, cleanupError: result.cleanupError }
      : { applied: false };
  }

  return {
    applied: true,
    decision: "draft_reply",
    draftEmailId: result.draftEmailId,
  };
}
