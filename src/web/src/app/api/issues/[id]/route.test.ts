import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetIssue = vi.fn();
const mockListIssueMessages = vi.fn();
const mockUpdateIssue = vi.fn();
const mockDeleteIssue = vi.fn();
const mockCreateMessage = vi.fn();
const mockListArtifactsByConversation = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      issue: {
        getIssue: (...a: unknown[]) => mockGetIssue(...a),
        listIssueMessages: (...a: unknown[]) => mockListIssueMessages(...a),
        updateIssue: (...a: unknown[]) => mockUpdateIssue(...a),
        deleteIssue: (...a: unknown[]) => mockDeleteIssue(...a),
      },
      message: { createMessage: (...a: unknown[]) => mockCreateMessage(...a) },
      artifact: {
        listArtifactsByConversation: (...a: unknown[]) => mockListArtifactsByConversation(...a),
        artifactToResponse: (a: any) => ({ id: a.id, filename: a.filename }),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  },
}));

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));

vi.mock("@/lib/api/responses", () => ({
  issueToResponse: (i: any) => ({ id: i.id, status: i.status, conversation_id: i.conversationId }),
  messageToResponse: (m: any) => ({ id: m.id, role: m.role, content: m.content }),
}));

import { GET, PATCH, POST, DELETE } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/issues/[id]", () => {
  it("returns issue and messages", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1" });
    mockListIssueMessages.mockResolvedValue([{ id: "m1", role: "event", content: "Created" }]);
    mockListArtifactsByConversation.mockResolvedValue([{ id: "art_1", filename: "brief.md" }]);
    const res = await GET(new NextRequest("http://localhost/api/issues/iss_1"), { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issue: { id: "iss_1", status: "todo", conversation_id: "c1" },
      messages: [{ id: "m1", role: "event", content: "Created" }],
      artifacts: [{ id: "art_1", filename: "brief.md" }],
    });
    expect(mockListArtifactsByConversation).toHaveBeenCalledWith({}, "c1", "w1");
  });
});

describe("PATCH /api/issues/[id]", () => {
  it("updates status and records status transition", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1" });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1", status: "in_progress", conversationId: "c1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", {
      method: "PATCH",
      body: JSON.stringify({ status: "in_progress" }),
    });
    const res = await PATCH(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith({}, "iss_1", "w1", { title: undefined, description: undefined, status: "in_progress" });
    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "event", content: "Issue status changed: todo -> in_progress" }));
  });
});

describe("POST /api/issues/[id]", () => {
  it("adds a user comment for browser callers", async () => {
    mockGetIssue.mockResolvedValue({ id: "iss_1", status: "todo", conversationId: "c1" });
    mockCreateMessage.mockResolvedValue({ id: "m1", role: "user", content: "Looks good" });
    mockUpdateIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", {
      method: "POST",
      body: JSON.stringify({ content: "Looks good" }),
    });
    const res = await POST(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(201);
    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "user", content: "Looks good" }));
  });
});

describe("DELETE /api/issues/[id]", () => {
  it("deletes the issue and returns 204", async () => {
    mockDeleteIssue.mockResolvedValue({ id: "iss_1" });
    const req = new NextRequest("http://localhost/api/issues/iss_1", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_1" } } as any);
    expect(res.status).toBe(204);
    expect(mockDeleteIssue).toHaveBeenCalledWith({}, "iss_1", "w1");
  });

  it("returns 404 when issue does not exist", async () => {
    mockDeleteIssue.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/issues/iss_999", { method: "DELETE" });
    const res = await DELETE(req, { params: { id: "iss_999" } } as any);
    expect(res.status).toBe(404);
  });
});
