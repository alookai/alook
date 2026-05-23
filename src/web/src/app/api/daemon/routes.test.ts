import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Cross-route body-validation tests for daemon endpoints.
// Uses real Zod schemas (parseBody is NOT mocked) so we can assert that
// invalid payloads are rejected before hitting any DB logic.
// ---------------------------------------------------------------------------

const daemonAuth = { userId: "u1", email: "u@t.com", workspaceId: "w1" };

function baseMocks() {
  return {
    "@opennextjs/cloudflare": () => ({
      getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
    }),
    "@/lib/middleware/auth": () => ({
      withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
        const params =
          ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
        return handler(req, { ...daemonAuth, params });
      }),
    }),
    "@/lib/middleware/helpers": async () =>
      await vi.importActual<typeof import("@/lib/middleware/helpers")>(
        "@/lib/middleware/helpers"
      ),
    "@/lib/logger": () => ({
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  };
}

function applyBase() {
  const m = baseMocks();
  vi.doMock("@opennextjs/cloudflare", m["@opennextjs/cloudflare"]);
  vi.doMock("@/lib/db", () => ({
    getDb: vi.fn(() => ({})),
    withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
  }));
  vi.doMock("@/lib/middleware/auth", m["@/lib/middleware/auth"]);
  vi.doMock("@/lib/middleware/helpers", m["@/lib/middleware/helpers"]);
  vi.doMock("@/lib/logger", m["@/lib/logger"]);
}

function postReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function postRaw(url: string, raw: string) {
  return new NextRequest(url, {
    method: "POST",
    body: raw,
    headers: { "Content-Type": "application/json" },
  });
}

describe("daemon route body validation", () => {
  beforeEach(() => vi.clearAllMocks());

  // -----------------------------------------------------------------------
  // POST /daemon/register
  // -----------------------------------------------------------------------

  describe("POST /daemon/register", () => {
    async function loadRegister() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            member: {
              getMemberByUserAndWorkspace: vi.fn().mockResolvedValue({ id: "m1" }),
            },
            machine: {
              upsertMachine: vi.fn().mockResolvedValue({ daemonId: "d1", workspaceId: "w1" }),
            },
            runtime: {
              upsertAgentRuntime: vi.fn().mockResolvedValue({ id: "rt1", workspaceId: "w1" }),
            },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        runtimeToResponse: (r: any) => r,
      }));

      return (await import("./register/route")).POST;
    }

    it("returns 400 when workspace_id is empty", async () => {
      const POST = await loadRegister();
      const res = await POST(
        postReq("http://localhost/api/daemon/register", {
          workspace_id: "",
          daemon_id: "d1",
          runtimes: [{ type: "claude" }],
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when runtimes is empty array", async () => {
      const POST = await loadRegister();
      const res = await POST(
        postReq("http://localhost/api/daemon/register", {
          workspace_id: "w1",
          daemon_id: "d1",
          runtimes: [],
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON", async () => {
      const POST = await loadRegister();
      const res = await POST(
        postRaw("http://localhost/api/daemon/register", "not json{{{")
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid request body");
    });

    it("stores deviceInfo correctly", async () => {
      const POST = await loadRegister();
      const upsertMock = vi.fn().mockResolvedValue({
        id: "rt1",
        workspaceId: "w1",
        deviceInfo: "MacBook Pro",
      });

      // Re-mock with a trackable upsert
      vi.resetModules();
      applyBase();
      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            member: {
              getMemberByUserAndWorkspace: vi.fn().mockResolvedValue({ id: "m1" }),
            },
            machine: {
              upsertMachine: vi.fn().mockResolvedValue({ daemonId: "d1", workspaceId: "w1" }),
            },
            runtime: {
              upsertAgentRuntime: upsertMock,
            },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        runtimeToResponse: (r: any) => r,
      }));

      const POST2 = (await import("./register/route")).POST;
      await POST2(
        postReq("http://localhost/api/daemon/register", {
          workspace_id: "w1",
          daemon_id: "d1",
          device_name: "MacBook Pro",
          runtimes: [{ type: "claude" }],
        })
      );

      expect(upsertMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ deviceInfo: "MacBook Pro" })
      );
    });

    it("stores version in metadata", async () => {
      vi.resetModules();
      applyBase();

      const upsertMock = vi.fn().mockResolvedValue({
        id: "rt1",
        workspaceId: "w1",
      });

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            member: {
              getMemberByUserAndWorkspace: vi.fn().mockResolvedValue({ id: "m1" }),
            },
            machine: {
              upsertMachine: vi.fn().mockResolvedValue({ daemonId: "d1", workspaceId: "w1" }),
            },
            runtime: {
              upsertAgentRuntime: upsertMock,
            },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        runtimeToResponse: (r: any) => r,
      }));

      const POST = (await import("./register/route")).POST;
      await POST(
        postReq("http://localhost/api/daemon/register", {
          workspace_id: "w1",
          daemon_id: "d1",
          cli_version: "0.5.1",
          runtimes: [{ type: "claude", version: "3.5" }],
        })
      );

      expect(upsertMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          metadata: expect.objectContaining({ version: "3.5", cli_version: "0.5.1" }),
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /daemon/tasks/poll
  // -----------------------------------------------------------------------

  describe("POST /daemon/tasks/poll", () => {
    async function loadPoll() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            runtime: {
              getRuntimeIdsByDaemon: vi.fn().mockResolvedValue(["r1"]),
            },
            machine: {
              updateMachineLastSeen: vi.fn().mockResolvedValue(undefined),
            },
            agent: {
              getAgent: vi.fn().mockResolvedValue(null),
            },
          },
        };
      });
      vi.doMock("@/lib/services/task", () => ({
        TaskService: vi.fn().mockImplementation(() => ({
          claimTasksForRuntimes: vi.fn().mockResolvedValue([]),
        })),
      }));
      vi.doMock("@/lib/services/sweep", () => ({
        sweepStaleState: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock("@/lib/services/calendar", () => ({
        promoteDueCalendarEventsForWorkspace: vi.fn().mockResolvedValue(0),
      }));
      vi.doMock("@/lib/broadcast", () => ({
        broadcastToUser: vi.fn().mockResolvedValue(undefined),
      }));

      return (await import("./tasks/poll/route")).POST;
    }

    it("returns 400 when daemon_id is missing", async () => {
      const POST = await loadPoll();
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/poll", {})
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when daemon_id is empty string", async () => {
      const POST = await loadPoll();
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/poll", { daemon_id: "" })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when max_tasks is 0", async () => {
      const POST = await loadPoll();
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/poll", { daemon_id: "d1", max_tasks: 0 })
      );
      expect(res.status).toBe(400);
    });

    it("rejects old-format body with runtime_ids", async () => {
      const POST = await loadPoll();
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/poll", { runtime_ids: ["r1"] })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON", async () => {
      const POST = await loadPoll();
      const res = await POST(
        postRaw("http://localhost/api/daemon/tasks/poll", "not json{{{")
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid request body");
    });
  });

  // -----------------------------------------------------------------------
  // POST /daemon/deregister
  // -----------------------------------------------------------------------

  describe("POST /daemon/deregister", () => {
    async function loadDeregister() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            machine: {
              setMachineLastSeenNull: vi.fn().mockResolvedValue(undefined),
            },
          },
        };
      });
      vi.doMock("@/lib/broadcast", () => ({
        broadcastToUser: vi.fn().mockResolvedValue(undefined),
      }));

      return (await import("./deregister/route")).POST;
    }

    it("returns 400 when daemon_id is missing", async () => {
      const POST = await loadDeregister();
      const res = await POST(
        postReq("http://localhost/api/daemon/deregister", {})
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when daemon_id is empty", async () => {
      const POST = await loadDeregister();
      const res = await POST(
        postReq("http://localhost/api/daemon/deregister", {
          daemon_id: "",
        })
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON", async () => {
      const POST = await loadDeregister();
      const res = await POST(
        postRaw("http://localhost/api/daemon/deregister", "{{bad")
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid request body");
    });
  });

  // -----------------------------------------------------------------------
  // POST /daemon/tasks/:taskId/complete
  // -----------------------------------------------------------------------

  describe("POST /daemon/tasks/:taskId/complete", () => {
    async function loadComplete() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
        };
      });
      vi.doMock("@/lib/services/task", () => ({
        TaskService: vi.fn().mockImplementation(() => ({
          completeTask: vi.fn().mockResolvedValue({
            id: "t1",
            agentId: "a1",
            runtimeId: "rt1",
            workspaceId: "w1",
            conversationId: "c1",
            prompt: "p",
            status: "completed",
            priority: 0,
            dispatchedAt: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date().toISOString(),
          }),
        })),
      }));
      vi.doMock("@/lib/api/responses", () => ({
        taskToResponse: (t: any) => ({ id: t.id, status: t.status }),
      }));

      return (await import("./tasks/[taskId]/complete/route")).POST;
    }

    it("returns 400 on malformed JSON", async () => {
      const POST = await loadComplete();
      const res = await POST(
        postRaw("http://localhost/api/daemon/tasks/t1/complete", "{bad}"),
        { params: Promise.resolve({ taskId: "t1" }) }
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid request body");
    });
  });

  // -----------------------------------------------------------------------
  // POST /daemon/tasks/:taskId/fail
  // -----------------------------------------------------------------------

  describe("POST /daemon/tasks/:taskId/fail", () => {
    async function loadFail() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
        };
      });
      vi.doMock("@/lib/services/task", () => ({
        TaskService: vi.fn().mockImplementation(() => ({
          failTask: vi.fn().mockResolvedValue({
            id: "t1",
            agentId: "a1",
            runtimeId: "rt1",
            workspaceId: "w1",
            conversationId: "c1",
            prompt: "p",
            status: "failed",
            priority: 0,
            dispatchedAt: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date().toISOString(),
          }),
        })),
      }));
      vi.doMock("@/lib/api/responses", () => ({
        taskToResponse: (t: any) => ({ id: t.id, status: t.status }),
      }));

      return (await import("./tasks/[taskId]/fail/route")).POST;
    }

    it("returns 400 on malformed JSON", async () => {
      const POST = await loadFail();
      const res = await POST(
        postRaw("http://localhost/api/daemon/tasks/t1/fail", "nope"),
        { params: Promise.resolve({ taskId: "t1" }) }
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid request body");
    });
  });

  // -----------------------------------------------------------------------
  // POST /daemon/tasks/:taskId/messages
  // -----------------------------------------------------------------------

  describe("POST /daemon/tasks/:taskId/messages", () => {
    async function loadMessages() {
      vi.resetModules();
      applyBase();

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            task: {
              getTask: vi.fn().mockResolvedValue({ id: "t1", workspaceId: "w1" }),
            },
            taskMessage: {
              createTaskMessage: vi.fn().mockResolvedValue(undefined),
            },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        taskMessageToResponse: (m: any) => m,
      }));
      vi.doMock("@/lib/broadcast", () => ({
        broadcastToUser: vi.fn().mockResolvedValue(undefined),
      }));

      return (await import("./tasks/[taskId]/messages/route")).POST;
    }

    it("returns 400 when message item missing seq/type", async () => {
      const POST = await loadMessages();
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/t1/messages", {
          messages: [{ content: "hello" }],
        }),
        { params: Promise.resolve({ taskId: "t1" }) }
      );

      expect(res.status).toBe(400);
    });

    it("broadcasts task.messages via WebSocket after writing to DB", async () => {
      vi.resetModules();
      applyBase();

      const createMock = vi.fn().mockResolvedValue(undefined);
      const broadcastMock = vi.fn().mockResolvedValue(undefined);

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            task: {
              getTask: vi.fn().mockResolvedValue({ id: "t1", workspaceId: "w1" }),
            },
            taskMessage: { createTaskMessage: createMock },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        taskMessageToResponse: (m: any) => m,
      }));
      vi.doMock("@/lib/broadcast", () => ({
        broadcastToUser: broadcastMock,
      }));

      const POST = (await import("./tasks/[taskId]/messages/route")).POST;
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/t1/messages", {
          messages: [
            { seq: 1, type: "text", content: "hello" },
            { seq: 2, type: "tool-use", tool: "Read", content: "" },
          ],
        }),
        { params: Promise.resolve({ taskId: "t1" }) }
      );

      expect(res.status).toBe(200);
      expect(broadcastMock).toHaveBeenCalledWith(
        daemonAuth.userId,
        expect.objectContaining({
          type: "task.messages",
          taskId: "t1",
          messages: expect.arrayContaining([
            expect.objectContaining({ seq: 1, type: "text", content: "hello" }),
            expect.objectContaining({ seq: 2, type: "tool-use", tool: "Read" }),
          ]),
        })
      );
    });

    it("does not broadcast when messages array is empty", async () => {
      vi.resetModules();
      applyBase();

      const broadcastMock = vi.fn().mockResolvedValue(undefined);

      vi.doMock("@alook/shared", async () => {
        const real = await vi.importActual<typeof import("@alook/shared")>(
          "@alook/shared"
        );
        return {
          ...real,
          createDb: vi.fn(() => ({})),
          queries: {
            task: {
              getTask: vi.fn().mockResolvedValue({ id: "t1", workspaceId: "w1" }),
            },
            taskMessage: { createTaskMessage: vi.fn().mockResolvedValue(undefined) },
          },
        };
      });
      vi.doMock("@/lib/api/responses", () => ({
        taskMessageToResponse: (m: any) => m,
      }));
      vi.doMock("@/lib/broadcast", () => ({
        broadcastToUser: broadcastMock,
      }));

      const POST = (await import("./tasks/[taskId]/messages/route")).POST;
      const res = await POST(
        postReq("http://localhost/api/daemon/tasks/t1/messages", {
          messages: [],
        }),
        { params: Promise.resolve({ taskId: "t1" }) }
      );

      expect(res.status).toBe(200);
      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });
});
