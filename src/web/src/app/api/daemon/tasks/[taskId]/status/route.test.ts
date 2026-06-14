import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetTaskStatus = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  withD1Retry: vi.fn((fn: () => Promise<any>) => fn()),
}));

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    task: {
      getTaskStatus: (...args: any[]) => mockGetTaskStatus(...args),
    },
  },
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params =
      ctx?.params instanceof Promise ? await ctx.params : ctx?.params;
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", workspaceId: "w1", params });
  }),
}));
vi.mock("@/lib/middleware/helpers", async () => {
  return await vi.importActual<typeof import("@/lib/middleware/helpers")>(
    "@/lib/middleware/helpers"
  );
});

import { GET } from "./route";

const withParams = (taskId: string) => ({
  params: Promise.resolve({ taskId }),
});

describe("GET /api/daemon/tasks/[taskId]/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns task status", async () => {
    mockGetTaskStatus.mockResolvedValue("running");

    const res = await GET(
      new NextRequest("http://localhost/api/daemon/tasks/t1/status"),
      withParams("t1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "running" });
    expect(mockGetTaskStatus).toHaveBeenCalledWith({}, "t1", "w1");
  });

  it("returns 404 when task not found", async () => {
    mockGetTaskStatus.mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/daemon/tasks/t-missing/status"),
      withParams("t-missing")
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("task not found");
  });
});
