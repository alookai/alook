import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const upload = vi.fn();
const queryPort = { diagnosticQueries: true };
const createQueryPort = vi.fn(() => queryPort);
const createService = vi.fn(() => ({ upload, fail: vi.fn() }));

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

interface BundleRouteModule {
  PUT(request: NextRequest, context: { params: Promise<{ reportId: string }> }): Promise<Response>;
}

async function loadSubject(): Promise<BundleRouteModule> {
  return vi.importActual<BundleRouteModule>("./route.js");
}

const REPORT_ID = "dbr_0123456789abcdef";
const SHA256 = "a".repeat(64);
const BODY = new Uint8Array([1, 2, 3, 4]);
const context = { params: Promise.resolve({ reportId: REPORT_ID }) };

function request(overrides: {
  authorization?: string;
  headers?: Record<string, string>;
  omitHeaders?: string[];
  body?: BodyInit | null;
} = {}): NextRequest {
  const headers = new Headers({
    authorization: overrides.authorization ?? "Bearer cmk_valid",
    "content-type": "application/x-ndjson",
    "content-encoding": "gzip",
    "content-length": String(BODY.byteLength),
    "x-alook-content-sha256": SHA256,
    ...overrides.headers,
  });
  for (const name of overrides.omitHeaders ?? []) headers.delete(name);
  return new NextRequest(`http://localhost/api/community/daemon/diagnostics/${REPORT_ID}/bundle`, {
    method: "PUT",
    headers,
    body: overrides.body === undefined ? BODY : overrides.body,
  });
}

describe("PUT /api/community/daemon/diagnostics/:reportId/bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upload.mockResolvedValue({ kind: "terminal", status: "uploaded" });
  });

  it("requires cmk authentication before upload work", async () => {
    const api = await loadSubject();

    expect((await api.PUT(request({ authorization: "Bearer cmt_pairing" }), context)).status).toBe(401);
    expect((await api.PUT(request({ authorization: "" }), context)).status).toBe(401);
    expect(createService).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("ignores the false creation flag and drains an existing report for the authenticated machine", async () => {
    const api = await loadSubject();
    const response = await api.PUT(request(), context);

    expect(createQueryPort).toHaveBeenCalledWith({ diagnosticDb: true });
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({
      bucket: { privateBucket: true },
      queries: queryPort,
    }));
    expect(upload).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      machineId: "cm_original",
      sizeBytes: BODY.byteLength,
      sha256: SHA256,
      body: expect.any(ReadableStream),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: "terminal", status: "uploaded" });
  });

  it.each([
    ["invalid report id", { params: Promise.resolve({ reportId: "../foreign" }) }, request()],
    ["missing content type", context, request({ omitHeaders: ["content-type"] })],
    ["wrong content type", context, request({ headers: { "content-type": "application/gzip" } })],
    ["combined content type", context, request({ headers: { "content-type": "application/x-ndjson, application/x-ndjson" } })],
    ["absent encoding", context, request({ omitHeaders: ["content-encoding"] })],
    ["missing encoding", context, request({ headers: { "content-encoding": "" } })],
    ["combined encoding", context, request({ headers: { "content-encoding": "gzip, gzip" } })],
    ["missing length", context, request({ omitHeaders: ["content-length"] })],
    ["zero length", context, request({ headers: { "content-length": "0" } })],
    ["leading-zero length", context, request({ headers: { "content-length": "04" } })],
    ["signed length", context, request({ headers: { "content-length": "+4" } })],
    ["oversized length", context, request({ headers: { "content-length": String(10 * 1024 * 1024 + 1) } })],
    ["combined length", context, request({ headers: { "content-length": "4, 4" } })],
    ["missing checksum", context, request({ omitHeaders: ["x-alook-content-sha256"] })],
    ["short checksum", context, request({ headers: { "x-alook-content-sha256": "a".repeat(63) } })],
    ["uppercase checksum", context, request({ headers: { "x-alook-content-sha256": "A".repeat(64) } })],
    ["combined checksum", context, request({ headers: { "x-alook-content-sha256": `${SHA256},${SHA256}` } })],
  ])("rejects %s before R2/query service work", async (_name, targetContext, targetRequest) => {
    const api = await loadSubject();
    const response = await api.PUT(targetRequest, targetContext);

    expect(response.status).toBe(400);
    expect(createService).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a null body before upload work", async () => {
    const api = await loadSubject();
    const response = await api.PUT(request({ body: null }), context);

    expect(response.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    { name: "uploaded terminal", outcome: { kind: "terminal", status: "uploaded" }, status: 200 },
    { name: "failed terminal", outcome: { kind: "terminal", status: "failed" }, status: 409 },
    { name: "retryable", outcome: { kind: "retryable" }, status: 503 },
    { name: "rejected 400", outcome: { kind: "rejected", status: 400 }, status: 400 },
    { name: "rejected 404", outcome: { kind: "rejected", status: 404 }, status: 404 },
    { name: "rejected 409", outcome: { kind: "rejected", status: 409 }, status: 409 },
  ])("maps the strict $name service outcome to HTTP $status", async ({ outcome, status }) => {
    const api = await loadSubject();
    upload.mockResolvedValue(outcome);

    const response = await api.PUT(request(), context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(outcome);
  });
});
