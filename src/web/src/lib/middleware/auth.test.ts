import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    machineToken: {
      getMachineTokenByToken: vi.fn(),
      updateMachineTokenLastUsed: vi.fn(),
    },
  },
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: mockGetSession },
  })),
}));

import { withAuth } from "./auth";
import { queries } from "@alook/shared";

const mockGetMachineTokenByHash = queries.machineToken
  .getMachineTokenByToken as ReturnType<typeof vi.fn>;
const mockUpdateMachineTokenLastUsed = queries.machineToken
  .updateMachineTokenLastUsed as ReturnType<typeof vi.fn>;

const testHandler = vi.fn(async (_req: NextRequest, ctx: any) =>
  NextResponse.json({ ok: true, ctx })
);

describe("withAuth middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  const wrapped = withAuth(testHandler);

  it("returns 401 when Authorization header is missing", async () => {
    const req = new NextRequest("http://localhost/api/test");
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when Authorization format is not Bearer", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Basic abc123" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when Authorization has no token after Bearer", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer " },
    });

    mockGetSession.mockResolvedValue(null);

    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("authenticates valid Better Auth session and passes userId/email to handler", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-session-token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ctx.userId).toBe("user-1");
    expect(body.ctx.email).toBe("user@example.com");
    expect(testHandler).toHaveBeenCalledOnce();
  });

  it("returns 401 when Better Auth session is null", async () => {
    mockGetSession.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-session-token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("authenticates machine token (al_ prefix) via hash lookup", async () => {
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-1",
      userId: "user-mt",
      userEmail: "mt@example.com",
      workspaceId: "ws-1",
    });
    mockUpdateMachineTokenLastUsed.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_secret_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ctx.userId).toBe("user-mt");
    expect(body.ctx.email).toBe("mt@example.com");
    expect(body.ctx.workspaceId).toBe("ws-1");
    expect(mockGetMachineTokenByHash).toHaveBeenCalledOnce();
  });

  it("returns 401 for unknown machine token (getMachineTokenByToken returns null)", async () => {
    mockGetMachineTokenByHash.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_invalid_token" },
    });
    const res = await wrapped(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid token");
  });

  it("updates lastUsedAt on machine token auth", async () => {
    mockGetMachineTokenByHash.mockResolvedValue({
      id: "mt-2",
      userId: "user-mt2",
      userEmail: "mt2@example.com",
      workspaceId: null,
    });
    mockUpdateMachineTokenLastUsed.mockResolvedValue(undefined);

    const req = new NextRequest("http://localhost/api/test", {
      headers: { Authorization: "Bearer al_another_token" },
    });
    await wrapped(req);

    expect(mockUpdateMachineTokenLastUsed).toHaveBeenCalledWith({}, "mt-2");
  });

  it("resolves dynamic params from context", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-p", email: "p@example.com" },
    });

    const req = new NextRequest("http://localhost/api/test");
    const res = await wrapped(req, {
      params: Promise.resolve({ id: "x" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ctx.params).toEqual({ id: "x" });
  });
});
