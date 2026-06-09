import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetConversation = vi.fn();
const mockGetBranchOrigin = vi.fn();
const mockConversationBranchToResponse = vi.fn((b: any) => ({
  id: b.id,
  root_message_id: b.rootMessageId,
}));
const mockMessageToResponse = vi.fn((m: any) => ({
  id: m.id,
  content: m.content,
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/api/responses", () => ({
  conversationBranchToResponse: (...args: any[]) =>
    mockConversationBranchToResponse(...args),
  messageToResponse: (...args: any[]) => mockMessageToResponse(...args),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    CONVERSATION_TYPES: {
      USER_DM_MESSAGE: "user_dm_message",
      MESSAGE_BRANCH: "message_branch",
    },
    queries: {
      conversation: {
        getConversation: (...args: any[]) => mockGetConversation(...args),
      },
      conversationBranch: {
        getBranchOrigin: (...args: any[]) => mockGetBranchOrigin(...args),
      },
    },
  };
});

import { GET } from "./route";

const withParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/conversations/[id]/branch-origin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the origin branch and root message for an owned branch conversation", async () => {
    mockGetConversation.mockResolvedValue({
      id: "branch_c",
      userId: "u1",
      type: "message_branch",
    });
    mockGetBranchOrigin.mockResolvedValue({
      branch: { id: "br_1", rootMessageId: "m_root" },
      rootMessage: { id: "m_root", content: "original last message" },
    });

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/branch_c/branch-origin"),
      withParams("branch_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      branch: { id: "br_1", root_message_id: "m_root" },
      root_message: { id: "m_root", content: "original last message" },
    });
    expect(mockGetBranchOrigin).toHaveBeenCalledWith({}, {
      workspaceId: "w1",
      branchConversationId: "branch_c",
    });
  });

  it("rejects normal conversations", async () => {
    mockGetConversation.mockResolvedValue({
      id: "parent_c",
      userId: "u1",
      type: "user_dm_message",
    });

    const res = await GET(
      new NextRequest("http://localhost/api/conversations/parent_c/branch-origin"),
      withParams("parent_c"),
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("conversation is not a message branch");
    expect(mockGetBranchOrigin).not.toHaveBeenCalled();
  });
});
