import { beforeEach, describe, expect, it, vi } from "vitest";

const wsDoFetch = vi.fn();
vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...args: unknown[]) => wsDoFetch(...args),
}));

import { pushDiagnosticReportToMachine } from "./diagnostic-report-push";

const env = { WS_DO_WORKER: {}, DEV_WS_DO_URL: undefined } as unknown as Env;
const command = {
  reportId: "dbr_0123456789abcdef",
  agentId: "bot_1",
  fromMs: 1_700_000_000_000,
  deadlineAt: 1_700_087_000_000,
};

describe("pushDiagnosticReportToMachine", () => {
  beforeEach(() => wsDoFetch.mockReset());

  it("uses only the purpose-built diagnostics route and narrow body", async () => {
    wsDoFetch.mockResolvedValue(Response.json({ sent: 1 }));

    const outcome = await pushDiagnosticReportToMachine(env, "cm one", command);

    expect(outcome).toEqual({ kind: "delivered", sent: 1 });
    const [, path, init, audit] = wsDoFetch.mock.calls[0]!;
    expect(path).toBe("/community-machine/by-id/cm%20one/forward-diagnostics-collect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(command);
    expect(JSON.parse(init.body as string).type).toBeUndefined();
    expect(audit).toEqual({ label: "cm one", type: "diagnostics:collect" });
  });

  it("distinguishes delivered, definite offline, and ambiguous transport", async () => {
    wsDoFetch.mockResolvedValueOnce(Response.json({ sent: 2 }));
    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "delivered",
      sent: 2,
    });

    wsDoFetch.mockResolvedValueOnce(Response.json({ sent: 0 }));
    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "offline",
    });

    wsDoFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "ambiguous",
    });

    wsDoFetch.mockRejectedValueOnce(new Error("private network detail"));
    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "ambiguous",
    });
  });

  it.each([
    ["missing sent", {}],
    ["negative sent", { sent: -1 }],
    ["fractional sent", { sent: 0.5 }],
    ["string sent", { sent: "1" }],
  ])("fails closed on a 2xx response with %s", async (_label, response) => {
    wsDoFetch.mockResolvedValue(Response.json(response));

    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "ambiguous",
    });
  });
});
