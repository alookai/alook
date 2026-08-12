import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticReportFailureCode } from "@alook/shared";

type TransportResult =
  | { kind: "terminal"; status: "uploaded" | "failed" }
  | { kind: "retryable" };

interface HttpTransportModule {
  createDiagnosticHttpTransport(args: {
    serverUrl: string;
    machineKey: string;
    fetchImpl?: typeof fetch;
  }): {
    upload(
      meta: { reportId: string; sizeBytes: number; sha256: string },
      body: Readable,
    ): Promise<TransportResult>;
    fail(reportId: string, failureCode: DiagnosticReportFailureCode): Promise<TransportResult>;
  };
}

async function loadSubject(): Promise<HttpTransportModule> {
  return vi.importActual<HttpTransportModule>("./httpTransport.js");
}

async function streamBytes(value: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of value as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const REPORT_ID = "dbr_0123456789abcdef";
const SHA256 = "a".repeat(64);

describe("B2d daemon diagnostic HTTP transport", () => {
  it("streams an exact authenticated PUT without putting credentials in the URL or body", async () => {
    const api = await loadSubject();
    const archive = Buffer.from("diagnostic-gzip-bytes");
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit; body: Buffer }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init, body: await streamBytes(init?.body) });
      return Response.json({ kind: "terminal", status: "uploaded" });
    });
    const transport = api.createDiagnosticHttpTransport({
      serverUrl: "https://alook.test/",
      machineKey: "cmk_PRIVATE_UPLOAD_KEY",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(transport.upload({
      reportId: REPORT_ID,
      sizeBytes: archive.byteLength,
      sha256: SHA256,
    }, Readable.from([archive]))).resolves.toEqual({ kind: "terminal", status: "uploaded" });

    expect(requests).toHaveLength(1);
    expect(String(requests[0]!.input)).toBe(
      `https://alook.test/api/community/daemon/diagnostics/${REPORT_ID}/bundle`,
    );
    expect(requests[0]!.init).toMatchObject({ method: "PUT", duplex: "half" });
    expect(new Headers(requests[0]!.init?.headers)).toEqual(new Headers({
      authorization: "Bearer cmk_PRIVATE_UPLOAD_KEY",
      "content-type": "application/x-ndjson",
      "content-encoding": "gzip",
      "content-length": String(archive.byteLength),
      "x-alook-content-sha256": SHA256,
    }));
    expect(requests[0]!.body).toEqual(archive);
    expect(`${String(requests[0]!.input)}${requests[0]!.body.toString("utf8")}`).not.toContain(
      "cmk_PRIVATE_UPLOAD_KEY",
    );
  });

  it.each([
    ["uploaded", 200, { kind: "terminal", status: "uploaded" }],
    ["failed", 409, { kind: "terminal", status: "failed" }],
  ] as const)("accepts a strict %s terminal envelope", async (_name, status, body) => {
    const api = await loadSubject();
    const transport = api.createDiagnosticHttpTransport({
      serverUrl: "https://alook.test",
      machineKey: "cmk_test",
      fetchImpl: vi.fn(async () => Response.json(body, { status })) as typeof fetch,
    });

    await expect(transport.upload({ reportId: REPORT_ID, sizeBytes: 1, sha256: SHA256 }, Readable.from(["x"])))
      .resolves.toEqual(body);
  });

  it.each([
    ["network throw", () => Promise.reject(new Error("socket reset secret"))],
    ["server error", () => Promise.resolve(new Response("private server detail", { status: 503 }))],
    ["non-terminal JSON", () => Promise.resolve(Response.json({ status: "pending", detail: "secret" }))],
    ["malformed JSON", () => Promise.resolve(new Response("{", { status: 200 }))],
    ["unknown terminal", () => Promise.resolve(Response.json({ kind: "terminal", status: "other" }))],
  ])("normalizes %s to retryable and never rejects", async (_name, outcome) => {
    const api = await loadSubject();
    const transport = api.createDiagnosticHttpTransport({
      serverUrl: "https://alook.test",
      machineKey: "cmk_test",
      fetchImpl: vi.fn(outcome) as unknown as typeof fetch,
    });

    await expect(transport.upload({ reportId: REPORT_ID, sizeBytes: 1, sha256: SHA256 }, Readable.from(["x"])))
      .resolves.toEqual({ kind: "retryable" });
  });

  it("sends PATCH with only the fixed failure code and normalizes its terminal response", async () => {
    const api = await loadSubject();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const transport = api.createDiagnosticHttpTransport({
      serverUrl: "https://alook.test/",
      machineKey: "cmk_PATCH_KEY",
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Response.json({ kind: "terminal", status: "failed" });
      }) as typeof fetch,
    });

    await expect(transport.fail(REPORT_ID, "local_artifact_invalid")).resolves.toEqual({
      kind: "terminal",
      status: "failed",
    });
    expect(String(calls[0]!.input)).toBe(
      `https://alook.test/api/community/daemon/diagnostics/${REPORT_ID}`,
    );
    expect(calls[0]!.init).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ status: "failed", failureCode: "local_artifact_invalid" }),
    });
    expect(new Headers(calls[0]!.init?.headers)).toEqual(new Headers({
      authorization: "Bearer cmk_PATCH_KEY",
      "content-type": "application/json",
    }));
  });

  it("normalizes PATCH disconnects and non-terminal responses to retryable", async () => {
    const api = await loadSubject();
    for (const fetchImpl of [
      vi.fn(async () => { throw new Error("disconnect"); }),
      vi.fn(async () => Response.json({ kind: "retryable" }, { status: 503 })),
      vi.fn(async () => Response.json({ status: "pending" })),
    ]) {
      const transport = api.createDiagnosticHttpTransport({
        serverUrl: "https://alook.test",
        machineKey: "cmk_test",
        fetchImpl: fetchImpl as typeof fetch,
      });
      await expect(transport.fail(REPORT_ID, "upload_failed")).resolves.toEqual({ kind: "retryable" });
    }
  });
});
