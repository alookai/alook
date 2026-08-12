import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getForOwner = vi.fn();
const timeoutPending = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
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
        getDiagnosticReportForOwner: (...args: unknown[]) => getForOwner(...args),
        timeoutPendingDiagnosticReport: (...args: unknown[]) => timeoutPending(...args),
      },
    },
  };
});

import { GET } from "./route";

const NOW = 1_700_087_000_000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "dbr_0123456789abcdef",
    ownerUserId: "owner_1",
    agentId: "bot_1",
    machineId: "cm_private",
    clientNonce: "00000000-0000-4000-8000-000000000001",
    rateBucket: 1,
    status: "pending",
    failureCode: null,
    fromMs: NOW - 87_000_000,
    createdAt: NOW - 600_000,
    deadlineAt: NOW,
    completedAt: null,
    r2Key: null,
    sha256: null,
    sizeBytes: null,
    uploadedAt: null,
    objectExpiresAt: null,
    ...overrides,
  };
}

const request = new NextRequest("http://localhost/api/community/diagnostics/dbr_0123456789abcdef");
const context = { params: Promise.resolve({ reportId: "dbr_0123456789abcdef" }) };

describe("GET /api/community/diagnostics/:reportId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  it.each([
    ["invalid", "report_0123456789abcdef"],
    ["path-like", "dbr_../secret"],
  ])("rejects an %s report id before owner lookup", async (_label, reportId) => {
    const response = await GET(request, { params: Promise.resolve({ reportId }) });

    expect(response.status).toBe(400);
    expect(getForOwner).not.toHaveBeenCalled();
    expect(timeoutPending).not.toHaveBeenCalled();
  });

  it("scopes an existing report read by immutable owner", async () => {
    getForOwner.mockResolvedValue(row({ deadlineAt: NOW + 1 }));

    const response = await GET(request, context);

    expect(getForOwner).toHaveBeenCalledWith({}, {
      reportId: "dbr_0123456789abcdef",
      ownerUserId: "owner_1",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      report: {
        reportId: "dbr_0123456789abcdef",
        status: "pending",
        deadlineAt: NOW + 1,
        completedAt: null,
        failureCode: null,
        objectExpired: false,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/machine|clientNonce|r2|sha|size|fromMs/i);
  });

  it("returns 404 for another owner's report without a live bot or binding lookup", async () => {
    getForOwner.mockResolvedValue(null);

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(timeoutPending).not.toHaveBeenCalled();
  });

  it("lazily wins an expired pending timeout CAS and returns failed/timeout", async () => {
    getForOwner.mockResolvedValue(row());
    timeoutPending.mockResolvedValue(row({
      status: "failed",
      failureCode: "timeout",
      completedAt: NOW,
    }));

    const response = await GET(request, context);

    expect(timeoutPending).toHaveBeenCalledWith({}, {
      reportId: "dbr_0123456789abcdef",
      ownerUserId: "owner_1",
      nowMs: NOW,
    });
    await expect(response.json()).resolves.toMatchObject({
      report: { status: "failed", failureCode: "timeout", completedAt: NOW },
    });
  });

  it("reads back the authoritative owner row when the timeout CAS loses", async () => {
    getForOwner
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({
        status: "failed",
        failureCode: "offline",
        completedAt: NOW - 1,
      }));
    timeoutPending.mockResolvedValue(null);

    const response = await GET(request, context);

    expect(getForOwner).toHaveBeenCalledTimes(2);
    expect(getForOwner).toHaveBeenLastCalledWith({}, {
      reportId: "dbr_0123456789abcdef",
      ownerUserId: "owner_1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      report: { status: "failed", failureCode: "offline", completedAt: NOW - 1 },
    });
  });

  it("derives objectExpired without inventing an expired database status", async () => {
    getForOwner.mockResolvedValue(row({
      status: "uploaded",
      completedAt: NOW - 1_000,
      uploadedAt: NOW - 1_000,
      objectExpiresAt: NOW,
      r2Key: "bug-reports/owner_1/dbr_0123456789abcdef.ndjson.gz",
      sha256: "a".repeat(64),
      sizeBytes: 100,
    }));

    const response = await GET(request, context);

    await expect(response.json()).resolves.toEqual({
      report: {
        reportId: "dbr_0123456789abcdef",
        status: "uploaded",
        deadlineAt: NOW,
        completedAt: NOW - 1_000,
        failureCode: null,
        objectExpired: true,
      },
    });
  });
});
