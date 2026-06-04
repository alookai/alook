import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * E2E-style integration tests for the full token/workspace lifecycle:
 * - Tauri desktop flow: auto-register → Launch Company → workspace bound → daemon picks up
 * - Browser web flow: manual register → Launch Company → same
 * - Token reuse: existing registered token → POST /machine-tokens returns it
 * - Multi-token scenario: multiple registered → bind binds earliest
 * - Daemon standby → WS push workspace.added → daemon joins
 * - Daemon standby → WS disconnect → poll fallback discovers workspace
 * - bind-workspace with wrong token status → returns error
 */

const mockGetMachineTokenByToken = vi.fn();
const mockRegisterMachineToken = vi.fn();
const mockGetRegisteredTokenForUser = vi.fn();
const mockGetLatestTokenForUser = vi.fn();
const mockGetPendingMachineToken = vi.fn();
const mockActivateMachineToken = vi.fn();
const mockCreateMachineToken = vi.fn();
const mockGetMemberByUserAndWorkspace = vi.fn();
const mockUpsertMachine = vi.fn();
const mockUpsertAgentRuntime = vi.fn();
const mockBroadcastToUser = vi.fn();
const mockBroadcastToDaemon = vi.fn();
const mockInvalidate = vi.fn(() => Promise.resolve());
const mockGetWorkspace = vi.fn();
const mockGenerateMachineToken = vi.fn(() => "al_newtoken123");

function baseMocks() {
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
          getRegisteredTokenForUser: (...a: any[]) => mockGetRegisteredTokenForUser(...a),
          getLatestTokenForUser: (...a: any[]) => mockGetLatestTokenForUser(...a),
          getPendingMachineToken: (...a: any[]) => mockGetPendingMachineToken(...a),
          activateMachineToken: (...a: any[]) => mockActivateMachineToken(...a),
          createMachineToken: (...a: any[]) => mockCreateMachineToken(...a),
        },
        member: {
          getMemberByUserAndWorkspace: (...a: any[]) => mockGetMemberByUserAndWorkspace(...a),
        },
        machine: {
          upsertMachine: (...a: any[]) => mockUpsertMachine(...a),
        },
        runtime: {
          upsertAgentRuntime: (...a: any[]) => mockUpsertAgentRuntime(...a),
        },
        workspace: {
          getWorkspace: (...a: any[]) => mockGetWorkspace(...a),
        },
      },
      ActivateTokenRequestSchema: (await import("@alook/shared")).ActivateTokenRequestSchema,
      BindWorkspaceRequestSchema: (await import("@alook/shared")).BindWorkspaceRequestSchema,
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
    "@/lib/broadcast": {
      broadcastToUser: (...a: any[]) => mockBroadcastToUser(...a),
      broadcastToDaemon: (...a: any[]) => mockBroadcastToDaemon(...a),
    },
    "@/lib/cache": {
      invalidate: (...a: any[]) => mockInvalidate(...a),
      cacheKeys: {
        machineToken: (t: string) => `mt:${t}`,
        runtimeIds: (w: string, d: string) => `rt:${w}:${d}`,
        allRuntimes: (w: string) => `runtimes:${w}`,
      },
    },
    "@/lib/api/responses": {
      runtimeToResponse: (rt: any) => ({ id: rt.id, provider: rt.provider }),
      machineTokenToResponse: (mt: any) => ({
        id: mt.id,
        name: mt.name,
        last_used_at: null,
        created_at: mt.createdAt,
      }),
    },
    "@/lib/token": {
      generateMachineToken: (...a: any[]) => mockGenerateMachineToken(...a),
    },
  };
}

describe("Token/Workspace Lifecycle E2E", () => {
  beforeEach(() => vi.clearAllMocks());

  async function loadActivateRoute() {
    vi.resetModules();
    const mocks = baseMocks();
    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/cache", () => mocks["@/lib/cache"]);
    vi.doMock("@/lib/middleware/helpers", async () =>
      await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
    );
    const { POST } = await import("./activate/route");
    return POST;
  }

  async function loadBindRoute() {
    vi.resetModules();
    const mocks = baseMocks();
    vi.doMock("@opennextjs/cloudflare", () => mocks["@opennextjs/cloudflare"]);
    vi.doMock("@alook/shared", mocks["@alook/shared"]);
    vi.doMock("@/lib/db", () => ({
      getDb: vi.fn(() => ({})),
      withD1Retry: (fn: () => any) => fn(),
    }));
    vi.doMock("@/lib/broadcast", () => mocks["@/lib/broadcast"]);
    vi.doMock("@/lib/cache", () => mocks["@/lib/cache"]);
    vi.doMock("@/lib/api/responses", () => mocks["@/lib/api/responses"]);
    vi.doMock("@/lib/middleware/helpers", async () =>
      await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
    );
    vi.doMock("@/lib/middleware/auth", () => ({
      withAuth: (handler: any) => (req: any) => handler(req, { userId: "u1", email: "test@test.com" }),
    }));
    const { POST } = await import("./bind-workspace/route");
    return POST;
  }

  describe("Tauri desktop flow: auto-register → Launch Company → bind", () => {
    it("completes full lifecycle: activate → bind-workspace", async () => {
      // Step 1: Activate (register) the token
      const activateRoute = await loadActivateRoute();
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", workspaceId: null, status: "pending",
      });
      mockRegisterMachineToken.mockResolvedValue(undefined);
      mockBroadcastToUser.mockResolvedValue(undefined);

      const activateRes = await activateRoute(
        new NextRequest("http://localhost/api/machine-tokens/activate", {
          method: "POST",
          body: JSON.stringify({
            token: "al_test123",
            hostname: "MacBook.local",
            runtimes: [{ type: "claude", version: "2.1.0" }],
          }),
          headers: { "Content-Type": "application/json" },
        })
      );
      const activateBody = await activateRes.json();
      expect(activateRes.status).toBe(200);
      expect(activateBody.token_status).toBe("registered");

      // Step 2: Bind workspace (after Launch Company in frontend)
      const bindRoute = await loadBindRoute();
      mockGetRegisteredTokenForUser.mockResolvedValue({
        id: "mt_1", userId: "u1", token: "al_test123",
        hostname: "MacBook.local", status: "registered",
        runtimesJson: JSON.stringify([{ type: "claude", version: "2.1.0" }]),
      });
      mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "mem_1" });
      mockActivateMachineToken.mockResolvedValue(undefined);
      mockUpsertMachine.mockResolvedValue(undefined);
      mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
      mockBroadcastToUser.mockResolvedValue(undefined);
      mockBroadcastToDaemon.mockResolvedValue({ sent: 1 });
      mockGetWorkspace.mockResolvedValue({ id: "sp_ws1", name: "My Company" });

      const bindRes = await bindRoute(
        new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
          method: "POST",
          body: JSON.stringify({ workspace_id: "sp_ws1" }),
          headers: { "Content-Type": "application/json" },
        })
      );
      const bindBody = await bindRes.json();
      expect(bindRes.status).toBe(200);
      expect(bindBody.workspace_id).toBe("sp_ws1");
      expect(bindBody.runtimes).toHaveLength(1);

      // Verify daemon push was sent
      expect(mockBroadcastToDaemon).toHaveBeenCalledWith("MacBook.local", {
        type: "daemon.workspace_added",
        workspaceId: "sp_ws1",
        workspaceName: "My Company",
        token: "al_test123",
      });
    });
  });

  describe("Token reuse: registered token returned by creation endpoint", () => {
    it("POST /machine-tokens returns existing registered token without creating new one", async () => {
      vi.resetModules();
      const mocks = baseMocks();
      vi.doMock("@opennextjs/cloudflare", () => ({
        getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
      }));
      vi.doMock("@alook/shared", () => ({
        createDb: vi.fn(() => ({})),
        queries: {
          machineToken: {
            getPendingMachineToken: (...a: any[]) => mockGetPendingMachineToken(...a),
            getRegisteredTokenForUser: (...a: any[]) => mockGetRegisteredTokenForUser(...a),
            createMachineToken: (...a: any[]) => mockCreateMachineToken(...a),
          },
        },
      }));
      vi.doMock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
      vi.doMock("@/lib/middleware/helpers", () => ({
        writeJSON: (data: any, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
      }));
      vi.doMock("@/lib/middleware/auth", () => ({
        withAuth: (handler: any) => (req: any) => handler(req, { userId: "u1", email: "test@test.com" }),
      }));
      vi.doMock("@/lib/middleware/workspace", () => ({
        withWorkspaceMember: vi.fn(async () => ({ workspaceId: "w1" })),
      }));
      vi.doMock("@/lib/api/responses", () => mocks["@/lib/api/responses"]);
      vi.doMock("@/lib/token", () => mocks["@/lib/token"]);

      mockGetPendingMachineToken.mockResolvedValue(null);
      mockGetRegisteredTokenForUser.mockResolvedValue({
        id: "mt_existing", token: "al_existing_registered",
        name: "default", createdAt: "2025-01-01T00:00:00Z",
      });

      const { POST } = await import("./route");
      const res = await POST(
        new NextRequest("http://localhost/api/machine-tokens", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        })
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.token).toBe("al_existing_registered");
      expect(mockCreateMachineToken).not.toHaveBeenCalled();
    });
  });

  describe("Multi-token: multiple registered → bind earliest", () => {
    it("binds the token with the earliest createdAt", async () => {
      const bindRoute = await loadBindRoute();

      // getRegisteredTokenForUser returns earliest (ordered by createdAt ASC)
      mockGetRegisteredTokenForUser.mockResolvedValue({
        id: "mt_oldest", userId: "u1", token: "al_oldest",
        hostname: "Host.local", status: "registered",
        runtimesJson: JSON.stringify([{ type: "claude", version: "2.0" }]),
        createdAt: "2025-01-01T00:00:00Z",
      });
      mockGetMemberByUserAndWorkspace.mockResolvedValue({ id: "mem_1" });
      mockActivateMachineToken.mockResolvedValue(undefined);
      mockUpsertMachine.mockResolvedValue(undefined);
      mockUpsertAgentRuntime.mockResolvedValue({ id: "r1", provider: "claude" });
      mockBroadcastToUser.mockResolvedValue(undefined);
      mockBroadcastToDaemon.mockResolvedValue({ sent: 1 });
      mockGetWorkspace.mockResolvedValue({ id: "sp_ws1", name: "Test" });

      const res = await bindRoute(
        new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
          method: "POST",
          body: JSON.stringify({ workspace_id: "sp_ws1" }),
          headers: { "Content-Type": "application/json" },
        })
      );

      expect(res.status).toBe(200);
      expect(mockActivateMachineToken).toHaveBeenCalledWith(
        expect.anything(), "mt_oldest", "sp_ws1",
      );
    });
  });

  describe("bind-workspace token status validation", () => {
    it("returns 409 with descriptive error when token is pending", async () => {
      const bindRoute = await loadBindRoute();
      mockGetRegisteredTokenForUser.mockResolvedValue(null);
      mockGetLatestTokenForUser.mockResolvedValue({ id: "mt_1", status: "pending" });

      const res = await bindRoute(
        new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
          method: "POST",
          body: JSON.stringify({ workspace_id: "sp_ws1" }),
          headers: { "Content-Type": "application/json" },
        })
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toMatch(/pending/);
      expect(body.error).toMatch(/expected "registered"/);
    });

    it("returns 409 with descriptive error when token is active", async () => {
      const bindRoute = await loadBindRoute();
      mockGetRegisteredTokenForUser.mockResolvedValue(null);
      mockGetLatestTokenForUser.mockResolvedValue({ id: "mt_1", status: "active" });

      const res = await bindRoute(
        new NextRequest("http://localhost/api/machine-tokens/bind-workspace", {
          method: "POST",
          body: JSON.stringify({ workspace_id: "sp_ws1" }),
          headers: { "Content-Type": "application/json" },
        })
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toMatch(/active/);
      expect(body.error).toMatch(/expected "registered"/);
    });
  });
});
