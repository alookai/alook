import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetMachineTokenByToken = vi.fn();
const mockRegisterMachineToken = vi.fn();
const mockBroadcastToUser = vi.fn();

function sharedMocks() {
  return {
    "@opennextjs/cloudflare": {
      getCloudflareContext: vi.fn(() => Promise.resolve({ env: { DB: {} } })),
    },
    "@alook/shared": async () => ({
      createDb: vi.fn(() => ({})),
      queries: {
        machineToken: {
          getMachineTokenByToken: (...a: any[]) => mockGetMachineTokenByToken(...a),
          registerMachineToken: (...a: any[]) => mockRegisterMachineToken(...a),
        },
      },
      ActivateTokenRequestSchema: (await import("@alook/shared"))
        .ActivateTokenRequestSchema,
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
    },
  };
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/machine-tokens/activate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/machine-tokens/activate", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadRoute() {
    vi.resetModules();

    const mocks = sharedMocks();

    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/cache", () => ({
      invalidate: vi.fn(() => Promise.resolve()),
      cacheKeys: { machineToken: (t: string) => `mt:${t}` },
    }));
    vi.doMock("@/lib/middleware/helpers", async () => {
      return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      );
    });

    const { POST } = await import("./route");
    return POST;
  }

  const validBody = {
    token: "al_test123",
    hostname: "TestMachine.local",
    runtimes: [{ type: "claude", version: "2.1.0" }],
  };

  const pendingToken = {
    id: "mt_1",
    userId: "u1",
    workspaceId: null,
    status: "pending",
  };

  it("transitions token to registered status", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockRegisterMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.daemon_id).toBe("TestMachine.local");
    expect(body.token_status).toBe("registered");
    expect(body.workspace_id).toBeUndefined();
    expect(body.runtimes).toBeUndefined();
  });

  it("stores hostname and runtimes on the token", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockRegisterMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    expect(mockRegisterMachineToken).toHaveBeenCalledWith(
      expect.anything(),
      "mt_1",
      "TestMachine.local",
      JSON.stringify([{ type: "claude", version: "2.1.0" }]),
    );
  });

  it("broadcasts machine.registered event", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockRegisterMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    expect(mockBroadcastToUser).toHaveBeenCalledWith("u1", {
      type: "machine.registered",
      daemonId: "TestMachine.local",
      hostname: "TestMachine.local",
    });
  });

  it("returns 404 when token not found", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(null);

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("token not found");
    expect(mockRegisterMachineToken).not.toHaveBeenCalled();
  });

  it("returns 409 when token already used", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue({ ...pendingToken, status: "active" });

    const res = await POST(makeReq(validBody));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("token already used");
    expect(mockRegisterMachineToken).not.toHaveBeenCalled();
  });

  it("does not create workspace or machine rows", async () => {
    const POST = await loadRoute();

    mockGetMachineTokenByToken.mockResolvedValue(pendingToken);
    mockRegisterMachineToken.mockResolvedValue(undefined);
    mockBroadcastToUser.mockResolvedValue(undefined);

    await POST(makeReq(validBody));

    // Only registerMachineToken should be called — no workspace/machine/runtime creation
    expect(mockRegisterMachineToken).toHaveBeenCalledTimes(1);
  });
});
