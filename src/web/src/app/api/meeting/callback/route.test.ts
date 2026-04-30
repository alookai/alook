import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMeetingSession = vi.fn();
const mockUpdateMeetingSession = vi.fn();
const mockGetAgent = vi.fn();
const mockGetEmailByMessageId = vi.fn();
const mockBucketPut = vi.fn();
const mockSelfRefFetch = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({
    env: {
      DB: {},
      EMAIL_BUCKET: { put: (...args: unknown[]) => mockBucketPut(...args) },
      WORKER_SELF_REFERENCE: { fetch: (...args: unknown[]) => mockSelfRefFetch(...args) },
    },
  })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      meetingSession: {
        getMeetingSession: (...args: unknown[]) => mockGetMeetingSession(...args),
        updateMeetingSession: (...args: unknown[]) => mockUpdateMeetingSession(...args),
      },
      agent: {
        getAgent: (...args: unknown[]) => mockGetAgent(...args),
      },
      email: {
        getEmailByMessageId: (...args: unknown[]) => mockGetEmailByMessageId(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("nanoid", () => ({ nanoid: () => "test-nanoid-123" }));

import { POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/meeting/callback", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/meeting/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBucketPut.mockResolvedValue(undefined);
    mockSelfRefFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  });

  it("stores MIME email in R2 and calls email notify on completed meeting", async () => {
    mockGetMeetingSession.mockResolvedValue({
      id: "ms1",
      agentId: "a1",
      workspaceId: "w1",
      title: "Weekly",
      meetingUrl: "https://meet.google.com/abc",
      participants: ["alice@test.com"],
    });
    mockUpdateMeetingSession.mockResolvedValue({
      id: "ms1", status: "completed", transcriptR2Key: "meetings/ms1/transcript",
    });
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "jarvis", workspaceId: "w1" });
    mockGetEmailByMessageId.mockResolvedValue(null);

    const res = await POST(postReq({
      meetingId: "ms1",
      workspaceId: "w1",
      status: "completed",
      transcript: "[00:01] Alice: Hello",
    }));

    expect(res.status).toBe(200);

    // Should store raw transcript
    expect(mockBucketPut).toHaveBeenCalledWith(
      "meetings/ms1/transcript",
      "[00:01] Alice: Hello",
      { httpMetadata: { contentType: "text/plain" } },
    );

    // Should store MIME email at emails/{nanoid}/raw
    const mimeCall = mockBucketPut.mock.calls.find(
      (c: unknown[]) => (c[0] as string).startsWith("emails/")
    );
    expect(mimeCall).toBeDefined();
    expect(mimeCall![0]).toBe("emails/test-nanoid-123/raw");
    const mimeContent = mimeCall![1] as string;
    expect(mimeContent).toContain("From: no-reply@alook.ai");
    expect(mimeContent).toContain("To: jarvis@alook.ai");
    expect(mimeContent).toContain("Subject: Meeting transcript: Weekly");
    expect(mimeContent).toContain("MIME-Version: 1.0");
    expect(mimeContent).toContain("Content-Type: text/plain; charset=utf-8");
    expect(mimeContent).toContain("[00:01] Alice: Hello");

    // Should call email notify with correct r2Key
    expect(mockSelfRefFetch).toHaveBeenCalledTimes(1);
    const notifyBody = JSON.parse(
      (mockSelfRefFetch.mock.calls[0][1] as RequestInit).body as string
    );
    expect(notifyBody.r2Key).toBe("emails/test-nanoid-123/raw");
    expect(notifyBody.from).toBe("no-reply@alook.ai");
    expect(notifyBody.to).toBe("jarvis@alook.ai");
    expect(notifyBody.subject).toBe("Meeting transcript: Weekly");
    expect(notifyBody.isWhitelisted).toBe(true);
    expect(notifyBody.messageId).toBe("<meeting-ms1@alook.ai>");
  });

  it("skips email notify when agent has no emailHandle", async () => {
    mockGetMeetingSession.mockResolvedValue({
      id: "ms2", agentId: "a2", workspaceId: "w1", title: "Test", meetingUrl: "https://meet.google.com/xyz", participants: [],
    });
    mockUpdateMeetingSession.mockResolvedValue({ id: "ms2", status: "completed" });
    mockGetAgent.mockResolvedValue({ id: "a2", emailHandle: null, workspaceId: "w1" });

    const res = await POST(postReq({
      meetingId: "ms2",
      workspaceId: "w1",
      status: "completed",
      transcript: "some transcript",
    }));

    expect(res.status).toBe(200);
    expect(mockSelfRefFetch).not.toHaveBeenCalled();
    // Only one put: the raw transcript, no MIME email
    expect(mockBucketPut).toHaveBeenCalledTimes(1);
    expect(mockBucketPut.mock.calls[0][0]).toBe("meetings/ms2/transcript");
  });

  it("skips email notify on failed meeting", async () => {
    mockGetMeetingSession.mockResolvedValue({
      id: "ms3", agentId: "a1", workspaceId: "w1", title: "Fail", meetingUrl: "https://meet.google.com/abc", participants: [],
    });
    mockUpdateMeetingSession.mockResolvedValue({ id: "ms3", status: "failed" });

    const res = await POST(postReq({
      meetingId: "ms3",
      workspaceId: "w1",
      status: "failed",
      error: "Chrome crashed",
    }));

    expect(res.status).toBe(200);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockSelfRefFetch).not.toHaveBeenCalled();
  });

  it("dedup: skips email notify if messageId already exists", async () => {
    mockGetMeetingSession.mockResolvedValue({
      id: "ms4", agentId: "a1", workspaceId: "w1", title: "Dup", meetingUrl: "https://meet.google.com/abc", participants: [],
    });
    mockUpdateMeetingSession.mockResolvedValue({ id: "ms4", status: "completed" });
    mockGetAgent.mockResolvedValue({ id: "a1", emailHandle: "jarvis", workspaceId: "w1" });
    mockGetEmailByMessageId.mockResolvedValue({ id: "existing-email" });

    const res = await POST(postReq({
      meetingId: "ms4",
      workspaceId: "w1",
      status: "completed",
      transcript: "duplicate test",
    }));

    expect(res.status).toBe(200);
    expect(mockSelfRefFetch).not.toHaveBeenCalled();
    // Only raw transcript stored, no MIME email
    expect(mockBucketPut).toHaveBeenCalledTimes(1);
  });
});
