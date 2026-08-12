import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReportRow = {
  id: string;
  ownerUserId: string;
  machineId: string;
  status: "pending" | "uploaded" | "failed";
  deadlineAt: number;
  failureCode: string | null;
  r2Key: string | null;
  sha256: string | null;
  sizeBytes: number | null;
};

type UploadResult =
  | { kind: "terminal"; status: "uploaded" | "failed" }
  | { kind: "retryable" }
  | { kind: "rejected"; status: 400 | 404 | 409 };

interface QueryPort {
  getPending(input: { reportId: string; machineId: string; nowMs: number }): Promise<ReportRow | null>;
  get(input: { reportId: string; machineId: string }): Promise<ReportRow | null>;
  finalize(input: {
    reportId: string;
    machineId: string;
    r2Key: string;
    sha256: string;
    sizeBytes: number;
    nowMs: number;
  }): Promise<ReportRow | null>;
  fail(input: {
    reportId: string;
    machineId: string;
    failureCode: string;
    nowMs: number;
  }): Promise<ReportRow | null>;
  timeout(input: { reportId: string; ownerUserId: string; nowMs: number }): Promise<ReportRow | null>;
}

interface R2Port {
  put(key: string, body: ReadableStream<Uint8Array>, options: Record<string, unknown>): Promise<unknown | null>;
  head(key: string): Promise<{
    size: number;
    checksums?: { sha256?: ArrayBuffer };
  } | null>;
  delete(key: string): Promise<void>;
}

interface DiagnosticUploadModule {
  createDiagnosticUploadService(args: {
    bucket: R2Port;
    queries: QueryPort;
    now: () => number;
    fixedLengthStream?: (sizeBytes: number) => {
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
    }): Promise<UploadResult>;
    fail(args: {
      reportId: string;
      machineId: string;
      failureCode: string;
    }): Promise<UploadResult>;
  };
}

const fixedLengthBodies = new WeakSet<ReadableStream<Uint8Array>>();

async function loadSubject(): Promise<DiagnosticUploadModule> {
  return vi.importActual<DiagnosticUploadModule>("./diagnostic-upload.js");
}

const NOW = 1_700_086_400_000;
const REPORT_ID = "dbr_0123456789abcdef";
const MACHINE_ID = "cm_machine_original";
const OWNER_ID = "owner_private";
const SHA256 = createHash("sha256").update("bundle").digest("hex");
const KEY = `bug-reports/${OWNER_ID}/${REPORT_ID}.ndjson.gz`;

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: REPORT_ID,
    ownerUserId: OWNER_ID,
    machineId: MACHINE_ID,
    status: "pending",
    deadlineAt: NOW + 600_000,
    failureCode: null,
    r2Key: null,
    sha256: null,
    sizeBytes: null,
    ...overrides,
  };
}

function bytes(value = "bundle"): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function gatedBytes(value: string, onRead: () => void, release: Promise<void>): ReadableStream<Uint8Array> {
  let emitted = false;
  return new ReadableStream({
    async pull(controller) {
      if (emitted) return;
      emitted = true;
      onRead();
      await release;
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function exactShaArrayBuffer(hex: string): ArrayBuffer {
  const value = Uint8Array.from(Buffer.from(hex, "hex"));
  if (value.byteLength !== 32 || value.buffer.byteLength !== 32) {
    throw new Error("test checksum fixture must be an exact 32-byte ArrayBuffer");
  }
  return value.buffer;
}

function strictFixedLengthFactory(calls: number[]) {
  return (expected: number) => {
    calls.push(expected);
    let seen = 0;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) throw new Error("fixed length overflow");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected) throw new Error("fixed length underflow");
      },
    });
    fixedLengthBodies.add(transform.readable);
    return transform;
  };
}

function bodyToBytes(body: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Promise.resolve(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (!(body instanceof ReadableStream) || !fixedLengthBodies.has(body)) {
    return Promise.reject(new TypeError("R2 put rejected non-fixed-length stream"));
  }
  return (async () => {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  })();
}

function queryFake() {
  return {
    getPending: vi.fn(async () => row()),
    get: vi.fn(async () => row()),
    finalize: vi.fn(async (input) => row({
      status: "uploaded",
      r2Key: input.r2Key,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
    })),
    fail: vi.fn(async (input) => row({ status: "failed", failureCode: input.failureCode })),
    timeout: vi.fn(async () => row({ status: "failed", failureCode: "timeout" })),
  } satisfies QueryPort;
}

function r2Fake() {
  const objects = new Map<string, { body: Uint8Array; sha256: string }>();
  const claims = new Map<string, Promise<void>>();
  const put = vi.fn(async (
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView,
    options: Record<string, unknown>,
  ) => {
    const existingClaim = claims.get(key);
    const isWinner = !objects.has(key) && existingClaim === undefined;
    let releaseClaim: (() => void) | undefined;
    if (isWinner) {
      claims.set(key, new Promise<void>((resolve) => { releaseClaim = resolve; }));
    }
    try {
      const bytes = await bodyToBytes(body);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      expect((options.sha256 as ArrayBuffer).byteLength).toBe(32);
      const claimed = Buffer.from(options.sha256 as ArrayBuffer).toString("hex");
      if (checksum !== claimed) throw new Error("R2 checksum mismatch");
      if (!isWinner) {
        await existingClaim;
        return null;
      }
      objects.set(key, { body: bytes, sha256: checksum });
      return { key };
    } finally {
      if (isWinner) {
        releaseClaim?.();
        claims.delete(key);
      }
    }
  });
  return {
    objects,
    put,
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? { size: object.body.byteLength, checksums: { sha256: exactShaArrayBuffer(object.sha256) } }
        : null;
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
}

describe("B2d diagnostic upload service", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("Node/default path buffers a fixed-length body when FixedLengthStream is missing", async () => {
    const api = await loadSubject();
    const host = globalThis as { FixedLengthStream?: unknown };
    const previous = host.FixedLengthStream;
    Reflect.deleteProperty(host, "FixedLengthStream");

    try {
      const queries = queryFake();
      const bucket = r2Fake();
      const service = api.createDiagnosticUploadService({
        bucket,
        queries,
        now: () => NOW,
      });
      await expect(service.upload({
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        sizeBytes: 6,
        sha256: SHA256,
        body: bytes(),
      })).resolves.toEqual({ kind: "terminal", status: "uploaded" });
      expect(bucket.put.mock.calls[0]![1]).toBeInstanceOf(Uint8Array);
      expect((bucket.put.mock.calls[0]![1] as Uint8Array).byteLength).toBe(6);
      expect(queries.finalize).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(host, "FixedLengthStream");
      else host.FixedLengthStream = previous;
    }
  });

  it.each([
    ["under length", "bun", 6, SHA256],
    ["over length", "bundled!", 6, SHA256],
    ["same-length wrong SHA", "nope!!", 6, SHA256],
  ] as const)(
    "Node/default path rejects %s before R2 put",
    async (_label, payload, sizeBytes, sha256) => {
      const api = await loadSubject();
      const host = globalThis as { FixedLengthStream?: unknown };
      const previous = host.FixedLengthStream;
      Reflect.deleteProperty(host, "FixedLengthStream");

      try {
        const queries = queryFake();
        const bucket = r2Fake();
        const service = api.createDiagnosticUploadService({
          bucket,
          queries,
          now: () => NOW,
        });
        await expect(service.upload({
          reportId: REPORT_ID,
          machineId: MACHINE_ID,
          sizeBytes,
          sha256,
          body: bytes(payload),
        })).resolves.toEqual({ kind: "terminal", status: "failed" });
        expect(bucket.put).not.toHaveBeenCalled();
        expect(queries.fail).toHaveBeenCalledWith(expect.objectContaining({
          failureCode: "invalid_upload",
        }));
      } finally {
        if (previous === undefined) Reflect.deleteProperty(host, "FixedLengthStream");
        else host.FixedLengthStream = previous;
      }
    },
  );

  it("default factory prefers globalThis.FixedLengthStream when present (Workers)", async () => {
    const api = await loadSubject();
    const host = globalThis as {
      FixedLengthStream?: new (n: number) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    };
    const previous = host.FixedLengthStream;
    const calls: number[] = [];
    host.FixedLengthStream = class {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(expected: number) {
        const pair = strictFixedLengthFactory(calls)(expected);
        this.readable = pair.readable;
        this.writable = pair.writable;
      }
    };

    try {
      const queries = queryFake();
      const bucket = r2Fake();
      const service = api.createDiagnosticUploadService({
        bucket,
        queries,
        now: () => NOW,
      });
      await expect(service.upload({
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        sizeBytes: 6,
        sha256: SHA256,
        body: bytes(),
      })).resolves.toEqual({ kind: "terminal", status: "uploaded" });
      expect(calls).toEqual([6]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(host, "FixedLengthStream");
      else host.FixedLengthStream = previous;
    }
  });

  it("authorizes the immutable machine snapshot before R2 and streams a fixed-length conditional Standard object", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    const fixedLengths: number[] = [];
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory(fixedLengths),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "uploaded" });

    expect(queries.getPending).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      nowMs: NOW,
    });
    expect(fixedLengths).toEqual([6]);
    expect(bucket.put).toHaveBeenCalledWith(KEY, expect.any(ReadableStream), {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expect.any(ArrayBuffer),
      storageClass: "Standard",
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
    });
    expect((bucket.put.mock.calls[0]![2].sha256 as ArrayBuffer).byteLength).toBe(32);
    expect(queries.finalize).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      r2Key: KEY,
      sha256: SHA256,
      sizeBytes: 6,
      nowMs: NOW,
    });
    expect(KEY).not.toMatch(/^https?:/);
  });

  it("rejects a cross-machine or non-pending report before touching R2", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    queries.getPending.mockResolvedValue(null);
    queries.get.mockResolvedValue(null);
    const bucket = r2Fake();
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: "cm_foreign",
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "rejected", status: 404 });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(queries.finalize).not.toHaveBeenCalled();
  });

  it.each([
    ["under length", "short", 6],
    ["over length", "bundle!", 6],
    ["checksum mismatch", "bundle", 6, "b".repeat(64)],
  ])("fails %s as invalid_upload without retaining an object", async (_name, value, sizeBytes, sha = SHA256) => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    bucket.put.mockRejectedValue(new Error("indistinguishable R2 rejection"));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes,
      sha256: sha,
      body: bytes(value),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(queries.fail).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      failureCode: "invalid_upload",
      nowMs: NOW,
    });
    expect(bucket.objects.has(KEY)).toBe(false);
  });

  it("treats an R2 put throw as retryable and preserves the pending row", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    bucket.put.mockRejectedValue(new Error("indistinguishable R2 rejection"));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "retryable" });
    expect(queries.finalize).not.toHaveBeenCalled();
    expect(queries.fail).not.toHaveBeenCalled();
  });

  it("treats a destination close rejection after a valid source as retryable", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    let signalCloseAttempted!: () => void;
    const closeAttempted = new Promise<void>((resolve) => { signalCloseAttempted = resolve; });
    const opaqueError = new Error("indistinguishable destination rejection");
    bucket.put.mockImplementation(async () => {
      await closeAttempted;
      throw opaqueError;
    });
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: () => ({
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        writable: new WritableStream<Uint8Array>({
          close() {
            signalCloseAttempted();
            throw opaqueError;
          },
        }),
      }),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "retryable" });
    expect(queries.finalize).not.toHaveBeenCalled();
    expect(queries.fail).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("normalizes a D1 failure-CAS throw to retryable after local invalid upload detection", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    queries.fail.mockRejectedValue(new Error("D1 transient"));
    const bucket = r2Fake();
    bucket.put.mockRejectedValue(new Error("indistinguishable R2 rejection"));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: "b".repeat(64),
      body: bytes(),
    })).resolves.toEqual({ kind: "retryable" });
  });

  it("accepts a conditional-put loser only when HEAD has the exact size and canonical SHA", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    bucket.objects.set(KEY, { body: Buffer.from("bundle"), sha256: SHA256 });
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "uploaded" });
    expect(bucket.head).toHaveBeenCalledWith(KEY);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "equal",
      secondValue: "bundle",
      secondSize: 6,
      secondSha: SHA256,
      expected: { kind: "terminal", status: "uploaded" },
      failureCode: undefined,
    },
    {
      name: "different",
      secondValue: "bundlex",
      secondSize: 7,
      secondSha: createHash("sha256").update("bundlex").digest("hex"),
      expected: { kind: "terminal", status: "failed" },
      failureCode: "upload_conflict",
    },
  ])("resolves $name concurrent conditional PUTs by authoritative HEAD", async ({
    secondValue,
    secondSize,
    secondSha,
    expected,
    failureCode,
  }) => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });
    let releaseFirst!: () => void;
    let firstRead!: () => void;
    const firstReadPromise = new Promise<void>((resolve) => { firstRead = resolve; });
    const releasePromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: gatedBytes("bundle", firstRead, releasePromise),
    });
    await firstReadPromise;
    const second = service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: secondSize,
      sha256: secondSha,
      body: bytes(secondValue),
    });
    await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(2));
    releaseFirst();

    await expect(first).resolves.toEqual({ kind: "terminal", status: "uploaded" });
    await expect(second).resolves.toEqual(expected);
    expect(bucket.head).toHaveBeenCalledWith(KEY);
    expect(bucket.delete).not.toHaveBeenCalled();
    if (failureCode) {
      expect(queries.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode }));
    }
  });

  it.each([
    ["missing HEAD", null],
    ["wrong size", { size: 7, checksums: { sha256: exactShaArrayBuffer(SHA256) } }],
    ["missing checksum", { size: 6, checksums: {} }],
    ["wrong checksum", { size: 6, checksums: { sha256: exactShaArrayBuffer("b".repeat(64)) } }],
  ])("CASes upload_conflict for %s after a conditional-put loser", async (_name, head) => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    bucket.put.mockResolvedValue(null);
    bucket.head.mockResolvedValue(head);
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(queries.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "upload_conflict" }));
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("compensates a lost finalize CAS from authoritative readback without deleting another request's object", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ status: "uploaded", r2Key: KEY, sha256: SHA256, sizeBytes: 6 }));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "uploaded" });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("deletes only an object definitely created by this request after terminal failure is confirmed", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ status: "failed", failureCode: "timeout" }));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(bucket.delete).toHaveBeenCalledWith(KEY);
  });

  it("keeps an authoritative failed terminal when best-effort R2 deletion throws", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ status: "failed", failureCode: "timeout" }));
    bucket.delete.mockRejectedValue(new Error("R2 delete transient"));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(bucket.delete).toHaveBeenCalledWith(KEY);
  });

  it("times out an expired pending readback and deletes only after terminal timeout is confirmed", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ deadlineAt: NOW }));
    queries.timeout.mockResolvedValue(row({ status: "failed", failureCode: "timeout", deadlineAt: NOW }));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(queries.timeout).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      ownerUserId: OWNER_ID,
      nowMs: NOW,
    });
    expect(bucket.delete).toHaveBeenCalledWith(KEY);
  });

  it("retains a created object when the expired pending timeout CAS remains ambiguous", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ deadlineAt: NOW }));
    queries.timeout.mockResolvedValue(null);
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "retryable" });
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("returns conflict for uploaded_different readback and never deletes the authoritative object", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    queries.finalize.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({
      status: "uploaded",
      r2Key: KEY,
      sha256: "b".repeat(64),
      sizeBytes: 7,
    }));
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.upload({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      sizeBytes: 6,
      sha256: SHA256,
      body: bytes(),
    })).resolves.toEqual({ kind: "terminal", status: "failed" });
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(queries.fail).not.toHaveBeenCalled();
  });

  it("retains a created object when finalize readback is transient or still pending", async () => {
    const api = await loadSubject();
    for (const readback of [new Error("D1 transient"), row()]) {
      const queries = queryFake();
      const bucket = r2Fake();
      queries.finalize.mockResolvedValue(null);
      if (readback instanceof Error) queries.get.mockRejectedValue(readback);
      else queries.get.mockResolvedValue(readback);
      const service = api.createDiagnosticUploadService({
        bucket,
        queries,
        now: () => NOW,
        fixedLengthStream: strictFixedLengthFactory([]),
      });

      await expect(service.upload({
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        sizeBytes: 6,
        sha256: SHA256,
        body: bytes(),
      })).resolves.toEqual({ kind: "retryable" });
      expect(bucket.delete).not.toHaveBeenCalled();
    }
  });

  it("PATCH is guarded, same-code idempotent, and cannot downgrade an uploaded row", async () => {
    const api = await loadSubject();
    const queries = queryFake();
    const bucket = r2Fake();
    const service = api.createDiagnosticUploadService({
      bucket,
      queries,
      now: () => NOW,
      fixedLengthStream: strictFixedLengthFactory([]),
    });

    await expect(service.fail({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      failureCode: "upload_failed",
    })).resolves.toEqual({ kind: "terminal", status: "failed" });

    queries.fail.mockResolvedValue(null);
    queries.get.mockResolvedValue(row({ status: "failed", failureCode: "upload_failed" }));
    await expect(service.fail({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      failureCode: "upload_failed",
    })).resolves.toEqual({ kind: "terminal", status: "failed" });

    queries.get.mockResolvedValue(row({ status: "uploaded", r2Key: KEY, sha256: SHA256, sizeBytes: 6 }));
    await expect(service.fail({
      reportId: REPORT_ID,
      machineId: MACHINE_ID,
      failureCode: "upload_failed",
    })).resolves.toEqual({ kind: "rejected", status: 409 });
  });
});
