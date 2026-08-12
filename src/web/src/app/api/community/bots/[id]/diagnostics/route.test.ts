import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const createOrGet = vi.fn();
const failPending = vi.fn();
const getForOwner = vi.fn();
const pushDiagnostic = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/community/diagnostic-report-push", () => ({
  pushDiagnosticReportToMachine: (...args: unknown[]) => pushDiagnostic(...args),
}));
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: NextRequest, context?: any) => {
    const params = context?.params instanceof Promise ? await context.params : context?.params;
    return handler(req, {
      env: { DB: {} },
      userId: "owner_1",
      email: "owner@example.test",
      params,
    });
  },
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityDiagnosticReport: {
        ...actual.queries.communityDiagnosticReport,
        createOrGetPendingDiagnosticReport: (...args: unknown[]) => createOrGet(...args),
        failPendingDiagnosticReport: (...args: unknown[]) => failPending(...args),
        getDiagnosticReportForOwner: (...args: unknown[]) => getForOwner(...args),
      },
    },
  };
});

import { POST } from "./route";
import { queries } from "@alook/shared";

const NOW = 1_700_086_400_000;
const NONCE = "00000000-0000-4000-8000-000000000001";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "dbr_0123456789abcdef",
    ownerUserId: "owner_1",
    agentId: "bot_1",
    machineId: "cm_original",
    clientNonce: NONCE,
    rateBucket: Math.floor(NOW / 60_000),
    status: "pending",
    failureCode: null,
    fromMs: NOW - 86_400_000,
    createdAt: NOW,
    deadlineAt: NOW + 600_000,
    completedAt: null,
    r2Key: null,
    sha256: null,
    sizeBytes: null,
    uploadedAt: null,
    objectExpiresAt: null,
    ...overrides,
  };
}

function request(clientNonce = NONCE) {
  return new NextRequest("http://localhost/api/community/bots/bot_1/diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientNonce }),
  });
}

function requestBody(body: unknown) {
  return new NextRequest("http://localhost/api/community/bots/bot_1/diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "bot_1" }) };

describe("POST /api/community/bots/:id/diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    createOrGet.mockResolvedValue({ kind: "created", report: row() });
    pushDiagnostic.mockResolvedValue({ kind: "delivered", sent: 1 });
  });

  it.each([
    ["missing nonce", {}],
    ["invalid nonce", { clientNonce: "not-a-uuid" }],
    ["unknown key", { clientNonce: NONCE, machineId: "cm_injected" }],
  ])("rejects a strict body with %s before D1 or WS", async (_label, body) => {
    const response = await POST(requestBody(body), context);

    expect(response.status).toBe(400);
    expect(createOrGet).not.toHaveBeenCalled();
    expect(failPending).not.toHaveBeenCalled();
    expect(getForOwner).not.toHaveBeenCalled();
    expect(pushDiagnostic).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before D1 or WS", async () => {
    const malformed = new NextRequest("http://localhost/api/community/bots/bot_1/diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(malformed, context);

    expect(response.status).toBe(400);
    expect(createOrGet).not.toHaveBeenCalled();
    expect(failPending).not.toHaveBeenCalled();
    expect(getForOwner).not.toHaveBeenCalled();
    expect(pushDiagnostic).not.toHaveBeenCalled();
  });

  it("maps foreign, deleted, non-bot, or unbound atomic target failure to an owner-safe 404", async () => {
    createOrGet.mockRejectedValue(
      new queries.communityDiagnosticReport.DiagnosticReportTargetUnavailableError(),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "diagnostic target unavailable" });
    expect(pushDiagnostic).not.toHaveBeenCalled();
    expect(failPending).not.toHaveBeenCalled();
    expect(getForOwner).not.toHaveBeenCalled();
  });

  it("creates through the atomic owner gate and returns 202 accepted pending", async () => {
    const response = await POST(request(), context);

    expect(createOrGet).toHaveBeenCalledWith({}, {
      ownerUserId: "owner_1",
      agentId: "bot_1",
      clientNonce: NONCE,
      nowMs: NOW,
    });
    expect(createOrGet.mock.calls[0]![1]).not.toHaveProperty("machineId");
    expect(pushDiagnostic).toHaveBeenCalledWith(
      expect.anything(),
      "cm_original",
      {
        reportId: "dbr_0123456789abcdef",
        agentId: "bot_1",
        fromMs: NOW - 86_400_000,
        deadlineAt: NOW + 600_000,
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      delivery: "accepted",
      report: {
        reportId: "dbr_0123456789abcdef",
        status: "pending",
        deadlineAt: NOW + 600_000,
        completedAt: null,
        failureCode: null,
        objectExpired: false,
      },
    });
  });

  it("turns definitive sent=0 into guarded offline and returns a 200 terminal envelope", async () => {
    pushDiagnostic.mockResolvedValue({ kind: "offline" });
    const failed = row({ status: "failed", failureCode: "offline", completedAt: NOW + 1 });
    failPending.mockResolvedValue(failed);

    const response = await POST(request(), context);

    expect(failPending).toHaveBeenCalledWith({}, {
      reportId: "dbr_0123456789abcdef",
      machineId: "cm_original",
      failureCode: "offline",
      nowMs: NOW,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      delivery: "accepted",
      report: {
        reportId: "dbr_0123456789abcdef",
        status: "failed",
        deadlineAt: NOW + 600_000,
        completedAt: NOW + 1,
        failureCode: "offline",
        objectExpired: false,
      },
    });
  });

  it("reads the authoritative owner row when the sent=0 offline CAS loses", async () => {
    pushDiagnostic.mockResolvedValue({ kind: "offline" });
    failPending.mockResolvedValue(null);
    getForOwner.mockResolvedValue(row({
      status: "failed",
      failureCode: "timeout",
      completedAt: NOW + 2,
    }));

    const response = await POST(request(), context);

    expect(getForOwner).toHaveBeenCalledWith({}, {
      reportId: "dbr_0123456789abcdef",
      ownerUserId: "owner_1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      delivery: "accepted",
      report: { status: "failed", failureCode: "timeout", completedAt: NOW + 2 },
    });
  });

  it("keeps delivery unknown when the sent=0 offline CAS loses to a still-pending row", async () => {
    pushDiagnostic.mockResolvedValue({ kind: "offline" });
    failPending.mockResolvedValue(null);
    getForOwner.mockResolvedValue(row());

    const response = await POST(request(), context);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      delivery: "unknown",
      report: { reportId: "dbr_0123456789abcdef", status: "pending" },
    });
  });

  it("keeps ambiguous delivery pending with the same id and returns 202 unknown", async () => {
    pushDiagnostic.mockResolvedValue({ kind: "ambiguous" });

    const response = await POST(request(), context);

    expect(response.status).toBe(202);
    expect(failPending).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      delivery: "unknown",
      report: { reportId: "dbr_0123456789abcdef", status: "pending" },
    });
  });

  it("adopts a different-nonce existing pending report with 202 instead of conflict", async () => {
    createOrGet.mockResolvedValue({ kind: "existing_pending", report: row({ clientNonce: "another_nonce_1234" }) });

    const response = await POST(request(), context);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      delivery: "accepted",
      report: { reportId: "dbr_0123456789abcdef", status: "pending" },
    });
  });

  it("reuses a same-nonce row's original machine snapshot after rebind", async () => {
    createOrGet.mockResolvedValue({ kind: "same_nonce", report: row({ machineId: "cm_original" }) });

    await POST(request(), context);

    expect(pushDiagnostic).toHaveBeenCalledWith(expect.anything(), "cm_original", expect.anything());
  });

  it("returns an already-terminal same-nonce row without redispatch", async () => {
    createOrGet.mockResolvedValue({
      kind: "same_nonce",
      report: row({ status: "failed", failureCode: "offline", completedAt: NOW - 1 }),
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(pushDiagnostic).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      delivery: "accepted",
      report: { status: "failed", failureCode: "offline", completedAt: NOW - 1 },
    });
  });

  it("returns 409 without an adoptable report for same nonce on another agent", async () => {
    createOrGet.mockResolvedValue({ kind: "same_nonce", report: row({ agentId: "bot_other" }) });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(pushDiagnostic).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "diagnostic nonce belongs to another bot" });
  });

  it("returns 429 for the authoritative rate-bucket winner without WS dispatch", async () => {
    createOrGet.mockResolvedValue({ kind: "rate_limited", report: row({ id: "dbr_ratewinner1234" }) });

    const response = await POST(request(), context);

    expect(response.status).toBe(429);
    expect(pushDiagnostic).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("report");
  });
});
