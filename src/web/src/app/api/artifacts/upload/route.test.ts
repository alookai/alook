import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockPut = vi.fn().mockResolvedValue(undefined);
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, EMAIL_BUCKET: { put: mockPut } } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "xyz") }));

const mockGetConversation = vi.fn();
const mockCreateArtifact = vi.fn();
const mockGetAgent = vi.fn();
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    queries: {
      conversation: { getConversation: (...a: unknown[]) => mockGetConversation(...a) },
      artifact: {
        createArtifact: (...a: unknown[]) => mockCreateArtifact(...a),
        artifactToResponse: (a: any) => ({ id: a.id }),
      },
      agent: { getAgent: (...a: unknown[]) => mockGetAgent(...a) },
    },
  };
});
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { userId: "u1", email: "u@t.com", params });
  }),
}));
vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
}));
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

function formReq(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v as any);
  return new NextRequest("http://localhost/api/artifacts/upload", { method: "POST", body: fd });
}

describe("POST /api/artifacts/upload", () => {
  it("uploads a file to R2 and creates an artifact record", async () => {
    mockGetConversation.mockResolvedValue({ id: "c1", agentId: "a1" });
    mockCreateArtifact.mockResolvedValue({ id: "art_xyz" });
    mockGetAgent.mockResolvedValue({ ownerId: "owner1" });

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const res = await POST(formReq({ file, conversation_id: "c1" }), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "art_xyz" });
    expect(mockPut).toHaveBeenCalled();
    expect(mockCreateArtifact.mock.calls[0]![1]).toMatchObject({ workspaceId: "w1", conversationId: "c1" });
  });

  it("400 when file missing", async () => {
    const res = await POST(formReq({ conversation_id: "c1" }), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("file is required");
  });

  it("400 when conversation_id missing", async () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const res = await POST(formReq({ file }), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conversation_id is required");
  });

  it("413 when file exceeds the size limit", async () => {
    // 10 MB + 1 byte
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" });
    const res = await POST(formReq({ file: big, conversation_id: "c1" }), {});
    expect(res.status).toBe(413);
  });

  it("404 when conversation not in workspace", async () => {
    mockGetConversation.mockResolvedValue(null);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const res = await POST(formReq({ file, conversation_id: "c1" }), {});
    expect(res.status).toBe(404);
  });

  it("400 on non-multipart body (invalid form data)", async () => {
    const req = new NextRequest("http://localhost/api/artifacts/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });
});
