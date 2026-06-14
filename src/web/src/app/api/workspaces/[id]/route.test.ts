import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let mockAuthCtx: Record<string, unknown> = { userId: "u1", email: "u@t.com" };

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn((opts?: { async?: boolean }) => {
    const result = { env: { DB: {} } };
    return opts?.async ? Promise.resolve(result) : result;
  }),
}));

const mockGetWorkspace = vi.fn();
const mockUpdateWorkspace = vi.fn();
const mockDeleteWorkspace = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      workspace: {
        getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
        updateWorkspace: (...args: unknown[]) => mockUpdateWorkspace(...args),
        deleteWorkspace: (...args: unknown[]) => mockDeleteWorkspace(...args),
      },
    },
  };
});

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: { DB: {} }, ...mockAuthCtx, params });
  }),
}));

vi.mock("@/lib/middleware/helpers", async () =>
  await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
);

vi.mock("@/lib/middleware/workspace", () => ({
  withWorkspaceOwner: vi.fn(async () => ({ workspaceId: "w1", memberRole: "owner" })),
}));

vi.mock("@/lib/api/responses", async () =>
  await vi.importActual<typeof import("@/lib/api/responses")>("@/lib/api/responses")
);

import { GET, PATCH, DELETE } from "./route";

describe("GET /api/workspaces/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { userId: "u1", email: "u@t.com" };
  });

  it("returns workspace for a member", async () => {
    mockGetWorkspace.mockResolvedValue({
      id: "w1",
      name: "Acme",
      slug: "acme",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const req = new NextRequest("http://localhost/api/workspaces/w1");
    const res = await GET(req, { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe("w1");
    expect(body.name).toBe("Acme");
    expect(body.slug).toBe("acme");
    expect(mockGetWorkspace).toHaveBeenCalledWith({}, "w1", "u1");
  });

  it("returns 404 when workspace does not exist", async () => {
    mockGetWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w999");
    const res = await GET(req, { params: Promise.resolve({ id: "w999" }) } as any);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workspace not found" });
  });

  it("returns 404 when user is not a member of the workspace", async () => {
    mockGetWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w-other");
    const res = await GET(req, { params: Promise.resolve({ id: "w-other" }) } as any);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workspace not found" });
    expect(mockGetWorkspace).toHaveBeenCalledWith({}, "w-other", "u1");
  });

  it("passes userId to query so membership is enforced in SQL", async () => {
    mockAuthCtx = { userId: "u2", email: "other@t.com" };
    mockGetWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w1");
    const res = await GET(req, { params: Promise.resolve({ id: "w1" }) } as any);

    expect(res.status).toBe(404);
    expect(mockGetWorkspace).toHaveBeenCalledWith({}, "w1", "u2");
  });
});

describe("PATCH /api/workspaces/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { userId: "u1", email: "u@t.com" };
  });

  it("updates workspace name successfully", async () => {
    mockUpdateWorkspace.mockResolvedValue({
      id: "w1",
      name: "New Name",
      slug: "my-workspace",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    });

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "w1" }) } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe("New Name");
    expect(mockUpdateWorkspace).toHaveBeenCalledWith({}, "w1", { name: "New Name" });
  });

  it("returns 404 when workspace not found on update", async () => {
    mockUpdateWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when neither name nor slug is provided", async () => {
    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(400);
  });

  it("returns 409 when slug is already in use", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), {});
    mockUpdateWorkspace.mockRejectedValue(uniqueErr);

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "PATCH",
      body: JSON.stringify({ slug: "taken-slug" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/workspaces/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthCtx = { userId: "u1", email: "u@t.com" };
  });

  it("deletes workspace when confirm_name matches", async () => {
    mockGetWorkspace.mockResolvedValue({
      id: "w1",
      name: "My Workspace",
      slug: "my-workspace",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    mockDeleteWorkspace.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "DELETE",
      body: JSON.stringify({ confirm_name: "My Workspace" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(204);
    expect(mockDeleteWorkspace).toHaveBeenCalledWith({}, "w1");
  });

  it("returns 400 when confirm_name does not match", async () => {
    mockGetWorkspace.mockResolvedValue({
      id: "w1",
      name: "My Workspace",
      slug: "my-workspace",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "DELETE",
      body: JSON.stringify({ confirm_name: "Wrong Name" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workspace name does not match");
  });

  it("returns 404 when workspace not found", async () => {
    mockGetWorkspace.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "DELETE",
      body: JSON.stringify({ confirm_name: "My Workspace" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(404);
  });

  it("returns 400 when confirm_name is missing", async () => {
    const req = new NextRequest("http://localhost/api/workspaces/w1", {
      method: "DELETE",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "w1" }) } as any);
    expect(res.status).toBe(400);
  });
});
