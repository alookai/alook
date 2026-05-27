import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetEmailById = vi.fn();
const mockUpdateEmailMailbox = vi.fn();
const mockCreateEmail = vi.fn();
const mockDeleteEmail = vi.fn();
const mockPromoteInboundWithDraftReply = vi.fn();
const mockArchiveInboundDraftAsUntrust = vi.fn();
const mockGetInboundDraftEmailForAgent = vi.fn();
const mockGetAgent = vi.fn();

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      email: {
        getEmailById: (...args: unknown[]) => mockGetEmailById(...args),
        updateEmailMailbox: (...args: unknown[]) => mockUpdateEmailMailbox(...args),
        createEmail: (...args: unknown[]) => mockCreateEmail(...args),
        deleteEmail: (...args: unknown[]) => mockDeleteEmail(...args),
        promoteInboundWithDraftReply: (...args: unknown[]) => mockPromoteInboundWithDraftReply(...args),
        archiveInboundDraftAsUntrust: (...args: unknown[]) => mockArchiveInboundDraftAsUntrust(...args),
        getInboundDraftEmailForAgent: (...args: unknown[]) => mockGetInboundDraftEmailForAgent(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
    },
  };
});

import { applyEmailTriageResult, parseEmailTriageOutput } from "./email-triage";

const inboundEmail = {
  id: "e-inbound",
  agentId: "a1",
  workspaceId: "ws1",
  fromEmail: "sender@test.com",
  toEmail: "agent@alook.ai",
  subject: "Hello",
  messageId: "<msg@test.com>",
  inReplyTo: "",
  references: "",
  direction: "inbound",
  mailbox: "draft",
  status: "draft",
};

describe("parseEmailTriageOutput", () => {
  it("accepts untrust JSON", () => {
    const result = parseEmailTriageOutput(JSON.stringify({ decision: "untrust" }));
    expect(result).toEqual({ ok: true, decision: "untrust" });
  });

  it("accepts draft_reply JSON with subject and htmlBody", () => {
    const result = parseEmailTriageOutput(JSON.stringify({
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    }));
    expect(result).toEqual({
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    });
  });

  it("returns fail closed for invalid JSON", () => {
    expect(parseEmailTriageOutput("not json")).toEqual({ ok: false });
  });

  it("returns fail closed for unknown decision", () => {
    expect(parseEmailTriageOutput(JSON.stringify({ decision: "maybe" }))).toEqual({ ok: false });
  });

  it("returns fail closed for empty draft subject", () => {
    expect(parseEmailTriageOutput(JSON.stringify({
      decision: "draft_reply",
      draft: { subject: "", htmlBody: "<p>Thanks</p>" },
    }))).toEqual({ ok: false });
  });

  it("returns fail closed for empty draft htmlBody", () => {
    expect(parseEmailTriageOutput(JSON.stringify({
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "" },
    }))).toEqual({ ok: false });
  });
});

describe("applyEmailTriageResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmailById.mockResolvedValue(inboundEmail);
    mockGetInboundDraftEmailForAgent.mockResolvedValue(inboundEmail);
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "myagent" });
    mockUpdateEmailMailbox.mockResolvedValue({ ...inboundEmail });
    mockCreateEmail.mockResolvedValue({ id: "e-draft" });
    mockDeleteEmail.mockResolvedValue(undefined);
    mockPromoteInboundWithDraftReply.mockResolvedValue({ applied: true, draftEmailId: "e-draft" });
    mockArchiveInboundDraftAsUntrust.mockResolvedValue({ id: "e-inbound" });
  });

  it("moves original email to untrust and archives it", async () => {
    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "untrust",
    });

    expect(mockArchiveInboundDraftAsUntrust).toHaveBeenCalledWith({}, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
    expect(mockCreateEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true, decision: "untrust" });
  });

  it("loads inbound email through scoped inbound draft query", async () => {
    await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    });

    expect(mockGetInboundDraftEmailForAgent).toHaveBeenCalledWith({}, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "ws1",
    });
    expect(mockGetEmailById).not.toHaveBeenCalled();
  });

  it("returns fail closed when untrust scoped update does not match an inbound draft", async () => {
    mockArchiveInboundDraftAsUntrust.mockResolvedValue(null);

    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "untrust",
    });

    expect(result).toEqual({ applied: false });
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
    expect(mockCreateEmail).not.toHaveBeenCalled();
  });

  it("moves original email to inbox and creates outbound draft", async () => {
    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    });

    expect(mockPromoteInboundWithDraftReply).toHaveBeenCalledWith({}, {
      inboundEmailId: "e-inbound",
      agentId: "a1",
      workspaceId: "ws1",
      draft: {
        fromEmail: "myagent@alook.ai",
        toEmail: "sender@test.com",
        subject: "Re: Hello",
        htmlBody: "<p>Thanks</p>",
        inReplyTo: "<msg@test.com>",
        references: "<msg@test.com>",
      },
    });
    expect(mockCreateEmail).not.toHaveBeenCalled();
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true, decision: "draft_reply", draftEmailId: "e-draft" });
  });

  it("returns fail closed when shared draft reply apply helper fails", async () => {
    mockPromoteInboundWithDraftReply.mockResolvedValue({ applied: false });

    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    });

    expect(result).toEqual({ applied: false });
    expect(mockPromoteInboundWithDraftReply).toHaveBeenCalled();
    expect(mockCreateEmail).not.toHaveBeenCalled();
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
  });

  it("surfaces explicit cleanup failure from shared draft reply apply helper", async () => {
    mockPromoteInboundWithDraftReply.mockResolvedValue({
      applied: false,
      cleanupError: "failed to remove draft e-draft",
    });

    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Thanks</p>" },
    });

    expect(result).toEqual({ applied: false, cleanupError: "failed to remove draft e-draft" });
  });

  it("does not move original email or create draft for fail closed result", async () => {
    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", { ok: false });

    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
    expect(mockCreateEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: false });
  });

  it("returns not applied when inbound email is missing", async () => {
    mockGetEmailById.mockResolvedValue(null);
    mockGetInboundDraftEmailForAgent.mockResolvedValue(null);

    const result = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", {
      ok: true,
      decision: "untrust",
    });

    expect(result).toEqual({ applied: false });
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
  });

  it("integration: draft_reply keeps original in draft on invalid output", async () => {
    const invalid = await applyEmailTriageResult({}, "ws1", "a1", "e-inbound", { ok: false });
    expect(invalid).toEqual({ applied: false });
    expect(mockUpdateEmailMailbox).not.toHaveBeenCalled();
    expect(mockCreateEmail).not.toHaveBeenCalled();
  });
});
