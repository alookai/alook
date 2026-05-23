import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockListChannels = vi.fn();
const mockCreateChannel = vi.fn();
const mockChannelToResponse = vi.fn((c: any) => ({
  id: c.id,
  workspace_id: c.workspaceId,
  name: c.name,
  position: c.position ?? 0,
  created_at: c.createdAt,
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual("@alook/shared");
  return {
    ...actual,
    createDb: vi.fn(() => ({})),
    queries: {
      channel: {
        listChannels: (...args: any[]) => mockListChannels(...args),
        createChannel: (...args: any[]) => mockCreateChannel(...args),
      },
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
vi.mock("@/lib/api/responses", () => ({
  channelToResponse: (...args: any[]) => mockChannelToResponse(...args),
}));

import { GET, POST } from "./route";

describe("GET /api/channels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists channels", async () => {
    const channels = [
      { id: "ch_1", workspaceId: "w1", name: "default", createdAt: "2024-01-01T00:00:00Z" },
      { id: "ch_2", workspaceId: "w1", name: "work", createdAt: "2024-01-02T00:00:00Z" },
    ];
    mockListChannels.mockResolvedValue(channels);

    const res = await GET(new NextRequest("http://localhost/api/channels"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("default");
    expect(body[1].name).toBe("work");
    expect(mockListChannels).toHaveBeenCalledWith({}, "w1");
  });

  it("synthesizes virtual default channel when none exists", async () => {
    const channels = [
      { id: "ch_2", workspaceId: "w1", name: "work", createdAt: "2024-01-02T00:00:00Z" },
    ];
    mockListChannels.mockResolvedValue(channels);

    const res = await GET(new NextRequest("http://localhost/api/channels"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("default");
    expect(body[0].id).toBe("ch_default");
    expect(body[0].position).toBe(0);
    expect(body[1].name).toBe("work");
  });

  it("does not synthesize default when it already exists", async () => {
    const channels = [
      { id: "ch_1", workspaceId: "w1", name: "default", createdAt: "2024-01-01T00:00:00Z" },
    ];
    mockListChannels.mockResolvedValue(channels);

    const res = await GET(new NextRequest("http://localhost/api/channels"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("ch_1");
  });

  it("returns empty list with only virtual default when DB has no channels", async () => {
    mockListChannels.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/channels"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("default");
    expect(body[0].id).toBe("ch_default");
  });
});

describe("POST /api/channels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a channel", async () => {
    const created = { id: "ch_3", workspaceId: "w1", name: "personal", createdAt: "2024-01-03T00:00:00Z" };
    mockCreateChannel.mockResolvedValue(created);

    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "personal" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.name).toBe("personal");
    expect(mockCreateChannel).toHaveBeenCalledWith({}, { workspaceId: "w1", name: "personal" });
  });

  it("returns 400 for missing name", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name is required");
  });

  it("returns 400 for empty name", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "   " }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name is required");
  });

  it("returns 400 for name exceeding 32 characters", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "a".repeat(33) }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name must be 32 characters or less");
  });

  it("returns 400 for reserved name 'default'", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "default" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("cannot create a channel named 'default'");
  });

  it("returns 400 for name with invalid characters", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "my channel" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("name can only contain letters, digits, dashes, and underscores");
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid request body");
  });

  it("returns 409 for duplicate channel name", async () => {
    mockCreateChannel.mockRejectedValue(new Error("UNIQUE constraint failed: channel.name"));

    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "work" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("a channel with this name already exists");
  });

  it("accepts valid names with dashes and underscores", async () => {
    const created = { id: "ch_4", workspaceId: "w1", name: "my-channel_1", createdAt: "2024-01-04T00:00:00Z" };
    mockCreateChannel.mockResolvedValue(created);

    const res = await POST(
      new NextRequest("http://localhost/api/channels", {
        method: "POST",
        body: JSON.stringify({ name: "my-channel_1" }),
        headers: { "Content-Type": "application/json" },
      })
    );

    expect(res.status).toBe(201);
  });
});
