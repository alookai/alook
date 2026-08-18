import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findCredential = vi.fn();
const timeoutPending = vi.fn();
const listPending = vi.fn();
const pushDiagnostic = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {}, WS_DO_WORKER: {} } })),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/community/diagnostic-report-push", () => ({
  pushDiagnosticReportToMachine: (...args: unknown[]) => pushDiagnostic(...args),
}));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: {
        ...actual.queries.communityMachine,
        findActiveCredentialByBearer: (...args: unknown[]) => findCredential(...args),
      },
      communityDiagnosticReport: {
        ...actual.queries.communityDiagnosticReport,
        timeoutPendingDiagnosticReportsForMachine: (...args: unknown[]) => timeoutPending(...args),
        listPendingDiagnosticReportsForMachine: (...args: unknown[]) => listPending(...args),
      },
    },
  };
});

import { POST } from "./route";

const NOW = 1_800_000_000_000;
const pending = (id: string, deadlineAt: number) => ({
  id,
  agentId: `bot_${id}`,
  fromMs: NOW - 86_400_000,
  deadlineAt,
});

function request(): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/resync-diagnostics", {
    method: "POST",
    headers: { Authorization: "Bearer cmk_ok" },
  });
}

describe("POST /api/community/daemon/resync-diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    findCredential.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "owner_1",
      machineId: "cm_1",
    });
    timeoutPending.mockResolvedValue([]);
    listPending.mockResolvedValue([]);
  });

  it("expires overdue rows, then re-derives and re-attempts every pending report from D1", async () => {
    listPending.mockResolvedValue([
      pending("dbr_one", NOW + 10_000),
      pending("dbr_two", NOW + 20_000),
    ]);
    pushDiagnostic
      .mockResolvedValueOnce({ kind: "attempted", attempted: 1 })
      .mockResolvedValueOnce({ kind: "ambiguous" });

    const response = await POST(request());

    expect(timeoutPending).toHaveBeenCalledWith({}, { machineId: "cm_1", nowMs: NOW });
    expect(listPending).toHaveBeenCalledWith({}, { machineId: "cm_1", nowMs: NOW });
    expect(pushDiagnostic).toHaveBeenNthCalledWith(1, expect.anything(), "cm_1", {
      reportId: "dbr_one",
      agentId: "bot_dbr_one",
      fromMs: NOW - 86_400_000,
      deadlineAt: NOW + 10_000,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pending: 2, attempted: 1, ambiguous: 1 });
  });

  it("returns an empty recovery set without attempting delivery", async () => {
    const response = await POST(request());

    await expect(response.json()).resolves.toEqual({ pending: 0, attempted: 0, ambiguous: 0 });
    expect(pushDiagnostic).not.toHaveBeenCalled();
  });
});
