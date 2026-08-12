import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

interface HttpTransportModule {
  createDiagnosticHttpTransport(args: {
    serverUrl: string;
    machineKey: string;
  }): unknown;
}

async function loadSubject(): Promise<HttpTransportModule> {
  return vi.importActual<HttpTransportModule>("../diagnostics/httpTransport.js");
}

const roots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-lifecycle-real-"));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function runChild(args: {
  mode: "collect" | "recover";
  machineDir: string;
  serverUrl: string;
  machineKey: string;
  archiveBase64: string;
}): Promise<{ stdout: string; stderr: string }> {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageRoot = resolve(sourceRoot, "..");
  const coordinatorUrl = pathToFileURL(join(sourceRoot, "diagnostics/coordinator.ts")).href;
  const transportUrl = pathToFileURL(join(sourceRoot, "diagnostics/httpTransport.ts")).href;
  const script = `
    import { createHash } from "node:crypto";
    import { writeFileSync } from "node:fs";
    import { createDiagnosticReportCoordinator } from ${JSON.stringify(coordinatorUrl)};
    import { createDiagnosticHttpTransport } from ${JSON.stringify(transportUrl)};
    const command = {
      type: "diagnostics:collect",
      reportId: "dbr_0123456789abcdef",
      agentId: "bot_1",
      fromMs: 1700000000000,
      deadlineAt: 1700087000000,
    };
    const bytes = Buffer.from(process.env.TEST_ARCHIVE_BASE64, "base64");
    const coordinator = createDiagnosticReportCoordinator({
      machineDir: process.env.TEST_MACHINE_DIR,
      buildBundle: async ({ outputPath }) => {
        writeFileSync(outputPath, bytes, { mode: 0o600, flag: "wx" });
        return {
          path: outputPath,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
      transport: createDiagnosticHttpTransport({
        serverUrl: process.env.TEST_SERVER_URL,
        machineKey: process.env.TEST_MACHINE_KEY,
      }),
      now: () => 1700000001000,
      sleep: async () => {},
      scheduleRetry: () => () => {},
      retry: { maxAttemptsPerRound: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = process.env.TEST_MODE === "collect"
      ? await Promise.all([coordinator.collect(command), coordinator.collect(command)])
      : (await coordinator.recover(), []);
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: packageRoot,
      env: {
        ...process.env,
        TEST_MODE: args.mode,
        TEST_MACHINE_DIR: args.machineDir,
        TEST_SERVER_URL: args.serverUrl,
        TEST_MACHINE_KEY: args.machineKey,
        TEST_ARCHIVE_BASE64: args.archiveBase64,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`diagnostic child exited ${code}: ${stderr}`));
    });
  });
}

describe("B2d real-process diagnostic lifecycle", () => {
  it("restarts after body-received disconnect and retries the identical committed bytes", async () => {
    await loadSubject();
    const machineDir = tempRoot();
    const machineKey = "cmk_REAL_PROCESS_PRIVATE_KEY";
    const archive = gzipSync(Buffer.from('{"recordType":"bundle_header","schemaVersion":1}\n'));
    const expectedSha = createHash("sha256").update(archive).digest("hex");
    const received: Array<{ body: Buffer; length: string | null; sha256: string | null; url: string }> = [];
    let disconnectFirst = true;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          length: request.headers["content-length"] ?? null,
          sha256: request.headers["x-alook-content-sha256"] as string | null,
          url: request.url ?? "",
        });
        if (disconnectFirst) {
          disconnectFirst = false;
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ kind: "terminal", status: "uploaded" }));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local HTTP server did not bind");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      const first = await runChild({
        mode: "collect",
        machineDir,
        serverUrl,
        machineKey,
        archiveBase64: archive.toString("base64"),
      });
      expect(JSON.parse(first.stdout)).toEqual([
        { status: "pending" },
        { status: "pending" },
      ]);
      expect(received).toHaveLength(1);

      const diagnosticDir = join(machineDir, "diagnostics");
      const filesAfterDisconnect = readdirSync(diagnosticDir).sort();
      expect(filesAfterDisconnect).toEqual([
        "report-dbr_0123456789abcdef.json",
        "report-dbr_0123456789abcdef.ndjson.gz",
      ]);
      const persistedText = filesAfterDisconnect
        .map((file) => readFileSync(join(diagnosticDir, file)))
        .map((value) => value.toString("latin1"))
        .join("\n");
      expect(`${diagnosticDir}\n${first.stdout}\n${first.stderr}\n${persistedText}`).not.toContain(machineKey);

      await runChild({
        mode: "recover",
        machineDir,
        serverUrl,
        machineKey,
        archiveBase64: archive.toString("base64"),
      });

      expect(received).toHaveLength(2);
      for (const attempt of received) {
        expect(attempt.body).toEqual(archive);
        expect(attempt.length).toBe(String(archive.byteLength));
        expect(attempt.sha256).toBe(expectedSha);
        expect(attempt.url).toBe(
          "/api/community/daemon/diagnostics/dbr_0123456789abcdef/bundle",
        );
        expect(attempt.url).not.toContain(machineKey);
      }
      expect(readdirSync(diagnosticDir)).toEqual([]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 30_000);
});
