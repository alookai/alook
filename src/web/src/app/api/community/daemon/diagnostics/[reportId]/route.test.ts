import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const fail = vi.fn();
const queryPort = { diagnosticQueries: true };
const createQueryPort = vi.fn(() => queryPort);
const createService = vi.fn(() => ({ upload: vi.fn(), fail }));

vi.mock("@/lib/community/diagnostic-upload", () => ({
  createDiagnosticUploadQueryPort: (...args: unknown[]) => createQueryPort(...args),
  createDiagnosticUploadService: (...args: unknown[]) => createService(...args),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({ diagnosticDb: true }) }));

vi.mock("@/lib/middleware/community-daemon-auth", () => ({
  withCommunityDaemonAuth: (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: NextRequest, context?: { params?: Promise<Record<string, string>> }) => {
      if (request.headers.get("authorization") !== "Bearer cmk_valid") {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return handler(request, {
        env: { DB: {}, BUG_REPORTS: { privateBucket: true }, BUG_REPORTS_ENABLED: "false" },
        machineId: "cm_original",
        userId: "owner_1",
        credentialId: "cred_1",
        params: await context?.params,
      });
    },
}));

interface FailureRouteModule {
  PATCH(request: NextRequest, context: { params: Promise<{ reportId: string }> }): Promise<Response>;
}

async function loadSubject(): Promise<FailureRouteModule> {
  return vi.importActual<FailureRouteModule>("./route.js");
}

const REPORT_ID = "dbr_0123456789abcdef";
const context = { params: Promise.resolve({ reportId: REPORT_ID }) };
const DAEMON_FAILURE_CODES = [
  "diagnostics_unavailable",
  "collector_busy",
  "bot_not_bound",
  "collection_failed",
  "local_artifact_invalid",
  "bundle_too_large",
  "upload_failed",
] as const;

function request(body: unknown, authorization = "Bearer cmk_valid"): NextRequest {
  return new NextRequest(`http://localhost/api/community/daemon/diagnostics/${REPORT_ID}`, {
    method: "PATCH",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/community/daemon/diagnostics/:reportId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fail.mockResolvedValue({ kind: "terminal", status: "failed" });
  });

  it("requires cmk authentication before failure work", async () => {
    const api = await loadSubject();
    const response = await api.PATCH(
      request({ status: "failed", failureCode: "upload_failed" }, "Bearer cmt_pairing"),
      context,
    );

    expect(response.status).toBe(401);
    expect(fail).not.toHaveBeenCalled();
  });

  it.each(DAEMON_FAILURE_CODES)("accepts daemon failure code %s while the creation flag is false", async (failureCode) => {
    const api = await loadSubject();
    const response = await api.PATCH(request({ status: "failed", failureCode }), context);

    expect(createQueryPort).toHaveBeenCalledWith({ diagnosticDb: true });
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({
      bucket: { privateBucket: true },
      queries: queryPort,
    }));
    expect(fail).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      machineId: "cm_original",
      failureCode,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "terminal", status: "failed" });
  });

  it.each([
    ["missing status", { failureCode: "upload_failed" }],
    ["wrong status", { status: "uploaded", failureCode: "upload_failed" }],
    ["missing failure", { status: "failed" }],
    ["server-owned failure", { status: "failed", failureCode: "offline" }],
    ["server internal failure", { status: "failed", failureCode: "internal_error" }],
    ["unknown failure", { status: "failed", failureCode: "hostile_secret" }],
    ["unknown key", { status: "failed", failureCode: "upload_failed", detail: "private" }],
  ])("rejects a strict body with %s", async (_name, body) => {
    const api = await loadSubject();
    const response = await api.PATCH(request(body), context);

    expect(response.status).toBe(400);
    expect(fail).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and an invalid report id", async () => {
    const api = await loadSubject();
    const malformed = new NextRequest(`http://localhost/api/community/daemon/diagnostics/${REPORT_ID}`, {
      method: "PATCH",
      headers: { authorization: "Bearer cmk_valid", "content-type": "application/json" },
      body: "{",
    });

    expect((await api.PATCH(malformed, context)).status).toBe(400);
    expect((await api.PATCH(
      request({ status: "failed", failureCode: "upload_failed" }),
      { params: Promise.resolve({ reportId: "../foreign" }) },
    )).status).toBe(400);
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    { name: "failed terminal", outcome: { kind: "terminal", status: "failed" }, status: 200 },
    { name: "uploaded terminal", outcome: { kind: "terminal", status: "uploaded" }, status: 409 },
    { name: "retryable", outcome: { kind: "retryable" }, status: 503 },
    { name: "rejected 404", outcome: { kind: "rejected", status: 404 }, status: 404 },
    { name: "rejected 409", outcome: { kind: "rejected", status: 409 }, status: 409 },
  ])("maps the $name service outcome to HTTP $status", async ({ outcome, status }) => {
    const api = await loadSubject();
    fail.mockResolvedValue(outcome);

    const response = await api.PATCH(
      request({ status: "failed", failureCode: "upload_failed" }),
      context,
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(outcome);
  });
});
