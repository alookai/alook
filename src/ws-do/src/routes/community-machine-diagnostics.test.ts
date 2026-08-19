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

  it("constructs the exact HostCommand, accepts a legacy inner receipt, and dual-writes for old web", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b", "do-c"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockResolvedValueOnce(Response.json({ attempted: 0, sent: 0 }))
      .mockResolvedValueOnce(Response.json({ sent: 0 }))
      .mockResolvedValueOnce(Response.json({ attempted: 1, sent: 1 }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ attempted: 1, sent: 1 });
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(4);
    const deadline = context.doMock.stubFetch.mock.calls[0]![0] as Request;
    expect(deadline.url).toBe("http://internal/register-diagnostic-deadline?machineId=cm_1");
    await expect(deadline.clone().json()).resolves.toEqual({ deadlineAt: payload.deadlineAt });
    const forwarded = context.doMock.stubFetch.mock.calls.slice(1).map(([value]) => value as Request);
    expect(forwarded.every((value) => value.url === "http://internal/forward-diagnostics-collect")).toBe(true);
    expect(await forwarded[0].clone().json()).toEqual({ type: "diagnostics:collect", ...payload });
    expect(forwarded.some((value) => value.url.endsWith("/push"))).toBe(false);
  });

  it("returns definite offline only when every credential reports zero", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockResolvedValueOnce(Response.json({ attempted: 0, sent: 0 }))
      .mockResolvedValueOnce(Response.json({ attempted: 0, sent: 0 }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ attempted: 0, sent: 0 });
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(3);
  });

  it("returns ambiguous when no delivery succeeds and any credential is non-definitive", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b", "do-c"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockResolvedValueOnce(Response.json({ attempted: 0 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ attempted: "one" }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(4);
  });

  it("returns ambiguous when one credential succeeds but another forward fails", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockResolvedValueOnce(Response.json({ attempted: 1, sent: 1 }))
      .mockRejectedValueOnce(new Error("credential transport failed"));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostic delivery ambiguous" });
  });

  it.each([
    ["missing", {}],
    ["negative", { attempted: -1 }],
    ["fractional", { attempted: 0.5 }],
    ["mismatched", { attempted: 1, sent: 0 }],
  ])("returns ambiguous for a %s inner receipt", async (_label, receipt) => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockResolvedValueOnce(Response.json(receipt));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostic delivery ambiguous" });
  });

  it("dual-writes zero after deadline registration when there are no active credentials", async () => {
    context.doMock.stubFetch.mockResolvedValueOnce(Response.json({ registered: true }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ attempted: 0, sent: 0 });
  });

  it("registers the deadline before an active-credential lookup failure", async () => {
    context.doMock.stubFetch.mockResolvedValueOnce(Response.json({ registered: true }));
    getActiveDoNamesForMachine.mockRejectedValueOnce(new Error("D1 unavailable"));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    expect(context.doMock.stubFetch).toHaveBeenCalledOnce();
    const deadline = context.doMock.stubFetch.mock.calls[0]![0] as Request;
    expect(deadline.url).toBe("http://internal/register-diagnostic-deadline?machineId=cm_1");
  });

  it("keeps the registered deadline when every active credential forward throws", async () => {
    getActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"]);
    context.doMock.stubFetch
      .mockResolvedValueOnce(Response.json({ registered: true }))
      .mockRejectedValueOnce(new Error("do-a unavailable"))
      .mockRejectedValueOnce(new Error("do-b unavailable"));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    expect(context.doMock.stubFetch).toHaveBeenCalledTimes(3);
    expect((context.doMock.stubFetch.mock.calls[0]![0] as Request).url)
      .toContain("/register-diagnostic-deadline");
  });

  it("fails explicitly before lookup or fanout when deadline registration fails", async () => {
    context.doMock.stubFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostic deadline registration failed" });
    expect(getActiveDoNamesForMachine).not.toHaveBeenCalled();
  });

  it.each([
    ["registered false", { registered: false }],
    ["missing receipt", {}],
    ["extra field", { registered: true, attempted: 1 }],
  ])("rejects a 200 deadline response with %s", async (_label, receipt) => {
    context.doMock.stubFetch.mockResolvedValueOnce(Response.json(receipt));

    const response = await handler.fetch(request(payload), context.env as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "diagnostic deadline registration failed" });
    expect(getActiveDoNamesForMachine).not.toHaveBeenCalled();
  });
});
