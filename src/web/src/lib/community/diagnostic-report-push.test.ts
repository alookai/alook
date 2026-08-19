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
    wsDoFetch.mockResolvedValue(Response.json({ attempted: 1, sent: 1 }));

    const outcome = await pushDiagnosticReportToMachine(env, "cm one", command);

    expect(outcome).toEqual({ kind: "attempted", attempted: 1 });
    const [, path, init, audit] = wsDoFetch.mock.calls[0]!;
    expect(path).toBe("/community-machine/by-id/cm%20one/forward-diagnostics-collect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(command);
    expect(JSON.parse(init.body as string).type).toBeUndefined();
    expect(audit).toEqual({ label: "cm one", type: "diagnostics:collect" });
  });

  it("distinguishes attempted, definite offline, and ambiguous transport", async () => {
    wsDoFetch.mockResolvedValueOnce(Response.json({ attempted: 2 }));
    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "attempted",
      attempted: 2,
    });

    wsDoFetch.mockResolvedValueOnce(Response.json({ attempted: 0 }));
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
    ["missing attempted", {}],
    ["legacy sent-only without deadline proof", { sent: 1 }],
    ["negative attempted", { attempted: -1 }],
    ["fractional attempted", { attempted: 0.5 }],
    ["string attempted", { attempted: "1" }],
    ["mismatched sent alias", { attempted: 1, sent: 0 }],
  ])("fails closed on a 2xx response with %s", async (_label, response) => {
    wsDoFetch.mockResolvedValue(Response.json(response));

    await expect(pushDiagnosticReportToMachine(env, "cm_1", command)).resolves.toEqual({
      kind: "ambiguous",
    });
  });
});
