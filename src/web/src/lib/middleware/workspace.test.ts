import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockGetMemberByUserAndWorkspace = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...real,
    queries: {
      member: {
        getMemberByUserAndWorkspace: (...args: unknown[]) => mockGetMemberByUserAndWorkspace(...args),
      },
    },
  };
});

import { withWorkspaceMember, withWorkspaceOwner } from "./workspace";

function makeReq(wsId?: string) {
  const url = wsId
    ? `http://localhost/api/test?workspace_id=${wsId}`
    : "http://localhost/api/test";
  return new NextRequest(url);
}

const auth = { userId: "u1", email: "u@t.com" };

describe("withWorkspaceMember", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns workspaceId and memberRole on success", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ role: "owner" });
    const result = await withWorkspaceMember(makeReq("w1"), auth);
    expect(result).toEqual({ workspaceId: "w1", memberRole: "owner" });
  });

  it("resolves workspace_id from params.id when no query param", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ role: "member" });
    const result = await withWorkspaceMember(makeReq(), { ...auth, params: { id: "w2" } });
    expect(result).toEqual({ workspaceId: "w2", memberRole: "member" });
  });

  it("returns 400 when workspace_id missing", async () => {
    const result = await withWorkspaceMember(makeReq(), auth);
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("returns 404 when not a member", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue(null);
    const result = await withWorkspaceMember(makeReq("w1"), auth);
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });
});

describe("withWorkspaceOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes for owner", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ role: "owner" });
    const result = await withWorkspaceOwner(makeReq("w1"), auth);
    expect(result).toEqual({ workspaceId: "w1", memberRole: "owner" });
  });

  it("returns 403 for member role", async () => {
    mockGetMemberByUserAndWorkspace.mockResolvedValue({ role: "member" });
    const result = await withWorkspaceOwner(makeReq("w1"), auth);
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });
});
