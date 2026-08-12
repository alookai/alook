import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRouterTestContext,
  getSharedMocks,
  loadRouter,
  type RouterHandler,
  type RouterTestContext,
} from "./test-harness";

const getActiveDoNamesForMachine = getSharedMocks().getActiveDoNamesForMachine;
const payload = {
  reportId: "dbr_0123456789abcdef",
  agentId: "bot_1",
  fromMs: 1_700_000_000_000,
  deadlineAt: 1_700_087_000_000,
};

describe("POST /community-machine/by-id/:machineId/forward-diagnostics-collect", () => {
  let handler: RouterHandler;
  let context: RouterTestContext;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    context = createRouterTestContext();
    handler = await loadRouter();
    getActiveDoNamesForMachine.mockReset().mockResolvedValue([]);
  });

  const request = (body: unknown) => new Request(
    "http://localhost/community-machine/by-id/cm_1/forward-diagnostics-collect",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );

  it.each([
    ["malformed JSON", "{"],
    ["missing reportId", { ...payload, reportId: undefined }],
    ["path-like reportId", { ...payload, reportId: "dbr_../secret" }],
    ["fractional epoch", { ...payload, fromMs: payload.fromMs + 0.5 }],
    ["unknown key", { ...payload, objectKey: "attacker-controlled" }],
  ])("strictly rejects %s before D1 or DO fanout", async (_label, body) => {
    const response = await handler.fetch(request(body), context.env as never);

    expect(response.status).toBe(400);
    expect(getActiveDoNamesForMachine).not.toHaveBeenCalled();
    expect(context.doMock.stubFetch).not.toHaveBeenCalled();
  });

  it("constructs the exact HostCommand and attempts every active credential", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b", "do-c"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ sent: 0 }))
      .mockRejectedValueOnce(new Error("credential transport failed"))
      .mockResolvedValueOnce(Response.json({ sent: 1 }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sent: 1 });
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(3);
    const forwarded = context.doMock.stubFetch.mock.calls.map(([value]) => value as Request);
    expect(forwarded.every((value) => value.url === "http://internal/forward-diagnostics-collect")).toBe(true);
    expect(await forwarded[0].clone().json()).toEqual({ type: "diagnostics:collect", ...payload });
    expect(forwarded.some((value) => value.url.endsWith("/push"))).toBe(false);
  });

  it("returns definite offline only when every credential reports zero", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ sent: 0 }))
      .mockResolvedValueOnce(Response.json({ sent: 0 }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sent: 0 });
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(2);
  });

  it("returns ambiguous when no delivery succeeds and any credential is non-definitive", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b", "do-c"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ sent: 0 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ sent: "one" }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(3);
  });
});
