import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@alook/shared";
import { sqlQuery, sqlRun } from "@alook/test-utils";

interface UploadModule {
  createDiagnosticUploadQueryPort(db: unknown): unknown;
  createDiagnosticUploadService(args: {
    bucket: R2Bucket;
    queries: unknown;
    now: () => number;
    fixedLengthStream: (sizeBytes: number) => {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };
  }): {
    upload(args: {
      reportId: string;
      machineId: string;
      sizeBytes: number;
      sha256: string;
      body: ReadableStream<Uint8Array>;
    }): Promise<{ kind: string; status?: string }>;
    fail(args: {
      reportId: string;
      machineId: string;
      failureCode: string;
    }): Promise<{ kind: string; status?: string }>;
  };
}

async function loadSubject(): Promise<UploadModule> {
  return vi.importActual<UploadModule>("../../lib/community/diagnostic-upload.js");
}

const NOW = 1_786_531_200_000;
const OWNER = "e2e_upload_owner";
const AGENT = "e2e_upload_agent";
const MACHINE = "cm_e2e_upload_machine";
const REPORT = "dbr_e2e_upload_report";
const NONCE = "nonce_e2e_upload_1234";
const BODY = Buffer.from("real-e2e-diagnostic-gzip");
const SHA = createHash("sha256").update(BODY).digest("hex");
const KEY = `bug-reports/${OWNER}/${REPORT}.ndjson.gz`;

function realQueryDb() {
  const binding = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              return { results: sqlQuery(query, ...params) };
            },
            async raw() {
              return sqlQuery<Record<string, unknown>>(query, ...params).map(Object.values);
            },
          };
        },
      };
    },
  };
  return createDb(binding as never);
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function fixedLength(expected: number) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) throw new Error("overflow");
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expected) throw new Error("underflow");
    },
  });
}

function strictBucket() {
  const objects = new Map<string, Buffer>();
  const put = vi.fn(async (key: string, body: ReadableStream<Uint8Array>, options: R2PutOptions) => {
    if (objects.has(key)) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks);
    const expected = Buffer.from(options.sha256 as ArrayBuffer).toString("hex");
    if (createHash("sha256").update(value).digest("hex") !== expected) throw new Error("checksum");
    objects.set(key, value);
    return { key };
  });
  return {
    objects,
    binding: {
      put,
      head: vi.fn(async (key: string) => {
        const value = objects.get(key);
        if (!value) return null;
        const digest = Uint8Array.from(createHash("sha256").update(value).digest());
        return { size: value.byteLength, checksums: { sha256: digest.buffer } };
      }),
      delete: vi.fn(async (key: string) => { objects.delete(key); }),
    } as unknown as R2Bucket,
    put,
  };
}

function cleanup(): void {
  sqlRun("DELETE FROM community_diagnostic_report WHERE id = ?", REPORT);
}

function seedPending(): void {
  sqlRun(
    `INSERT INTO community_diagnostic_report (
      id, owner_user_id, agent_id, machine_id, client_nonce, rate_bucket,
      status, failure_code, from_ms, created_at, deadline_at, completed_at,
      r2_key, sha256, size_bytes, uploaded_at, object_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
    REPORT,
    OWNER,
    AGENT,
    MACHINE,
    NONCE,
    Math.floor(NOW / 60_000),
    NOW - 86_400_000,
    NOW,
    NOW + 600_000,
  );
}

beforeEach(() => {
  cleanup();
  seedPending();
});

afterAll(cleanup);

describe("B2d real SQLite diagnostic upload", () => {
  it("streams a private object and atomically finalizes the real report row", async () => {
    const api = await loadSubject();
    const bucket = strictBucket();
    const service = api.createDiagnosticUploadService({
      bucket: bucket.binding,
      queries: api.createDiagnosticUploadQueryPort(realQueryDb()),
      now: () => NOW + 1_000,
      fixedLengthStream: fixedLength,
    });

    await expect(service.upload({
      reportId: REPORT,
      machineId: MACHINE,
      sizeBytes: BODY.byteLength,
      sha256: SHA,
      body: stream(BODY),
    })).resolves.toEqual({ kind: "terminal", status: "uploaded" });

    expect(bucket.objects.get(KEY)).toEqual(BODY);
    expect(sqlQuery<Record<string, unknown>>(
      "SELECT status, r2_key, sha256, size_bytes FROM community_diagnostic_report WHERE id = ?",
      REPORT,
    )).toEqual([{
      status: "uploaded",
      r2_key: KEY,
      sha256: SHA,
      size_bytes: BODY.byteLength,
    }]);
  });

  it("denies a foreign machine before R2 and leaves the real row pending", async () => {
    const api = await loadSubject();
    const bucket = strictBucket();
    const service = api.createDiagnosticUploadService({
      bucket: bucket.binding,
      queries: api.createDiagnosticUploadQueryPort(realQueryDb()),
      now: () => NOW + 1_000,
      fixedLengthStream: fixedLength,
    });

    await expect(service.upload({
      reportId: REPORT,
      machineId: "cm_foreign",
      sizeBytes: BODY.byteLength,
      sha256: SHA,
      body: stream(BODY),
    })).resolves.toEqual({ kind: "rejected", status: 404 });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(sqlQuery<{ status: string }>(
      "SELECT status FROM community_diagnostic_report WHERE id = ?",
      REPORT,
    )).toEqual([{ status: "pending" }]);
  });

  it("PATCHes one fixed daemon failure and preserves terminal immutability on retry", async () => {
    const api = await loadSubject();
    const bucket = strictBucket();
    const service = api.createDiagnosticUploadService({
      bucket: bucket.binding,
      queries: api.createDiagnosticUploadQueryPort(realQueryDb()),
      now: () => NOW + 1_000,
      fixedLengthStream: fixedLength,
    });

    await expect(service.fail({
      reportId: REPORT,
      machineId: MACHINE,
      failureCode: "diagnostics_unavailable",
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    await expect(service.fail({
      reportId: REPORT,
      machineId: MACHINE,
      failureCode: "diagnostics_unavailable",
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(sqlQuery<Record<string, unknown>>(
      "SELECT status, failure_code FROM community_diagnostic_report WHERE id = ?",
      REPORT,
    )).toEqual([{ status: "failed", failure_code: "diagnostics_unavailable" }]);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});
