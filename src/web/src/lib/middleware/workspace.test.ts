import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    member: {
      getMemberByUserAndWorkspace: vi.fn(),
    },
  },
}));

import { withWorkspaceMember } from "./workspace";
import { queries } from "@alook/shared";
import type { AuthContext } from "./auth";

const mockGetMember = queries.member
  .getMemberByUserAndWorkspace as ReturnType<typeof vi.fn>;

describe("withWorkspaceMember", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns workspaceId from query param", async () => {
    mockGetMember.mockResolvedValue({ id: "m1" });

    const req = new NextRequest("http://localhost/api/test?workspace_id=w1");
    const auth: AuthContext = { userId: "u1", email: "u@test.com" };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toEqual({ workspaceId: "w1" });
    expect(mockGetMember).toHaveBeenCalledWith({}, "u1", "w1");
  });

  it("returns workspaceId from X-Workspace-ID header", async () => {
    mockGetMember.mockResolvedValue({ id: "m1" });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { "X-Workspace-ID": "w-header" },
    });
    const auth: AuthContext = { userId: "u1", email: "u@test.com" };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toEqual({ workspaceId: "w-header" });
  });

  it("returns workspaceId from auth context (machine token)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1" });

    const req = new NextRequest("http://localhost/api/test");
    const auth: AuthContext = {
      userId: "u1",
      email: "u@test.com",
      workspaceId: "w-auth",
    };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toEqual({ workspaceId: "w-auth" });
  });

  it("returns 400 when no workspace_id provided", async () => {
    const req = new NextRequest("http://localhost/api/test");
    const auth: AuthContext = { userId: "u1", email: "u@test.com" };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toBeInstanceOf(NextResponse);

    const res = result as NextResponse;
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("workspace_id is required");
  });

  it("returns 404 when user is not a member", async () => {
    mockGetMember.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/test?workspace_id=w1");
    const auth: AuthContext = { userId: "u1", email: "u@test.com" };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toBeInstanceOf(NextResponse);

    const res = result as NextResponse;
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe("workspace not found");
  });

  it("returns 401 when userId is missing", async () => {
    const req = new NextRequest("http://localhost/api/test?workspace_id=w1");
    const auth: AuthContext = { userId: "", email: "u@test.com" };

    const result = await withWorkspaceMember(req, auth);
    expect(result).toBeInstanceOf(NextResponse);

    const res = result as NextResponse;
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.error).toBe("user not authenticated");
  });
});
