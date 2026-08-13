import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageVersion = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version: string;
}).version;
const tempRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packed daemon version", () => {
  it("reports the root package version from the real dist/cli bin", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-daemon-version-pack-"));
    tempRoots.push(root);
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) throw new Error("npm_execpath is required to build the packed daemon fixture");

    await execFileAsync(
      process.execPath,
      [npmExecPath, "pack", "--pack-destination", root],
      { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const tarball = readdirSync(root).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("daemon pack did not produce a tarball");
    await execFileAsync("tar", ["-xzf", join(root, tarball), "-C", root]);
    symlinkSync(join(packageRoot, "node_modules"), join(root, "package", "node_modules"), "junction");

    let activationBody: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        activationBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stop after version capture" }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

    const baseDir = join(root, "daemon-data");
    await execFileAsync(
      process.execPath,
      [
        join(root, "package", "dist", "cli", "index.js"),
        "daemon",
        "start",
        "--machine-key",
        "cmt_packed_version_test",
        "--server-url",
        `http://127.0.0.1:${address.port}`,
        "--ws-url",
        `ws://127.0.0.1:${address.port}`,
        "--base-dir",
        baseDir,
      ],
      {
        env: {
          ...process.env,
          ALOOK_DATA_DIR: baseDir,
          ALOOK_PROJECT_ROOT: root,
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    expect(activationBody).toEqual(expect.objectContaining({ daemonVersion: packageVersion }));
    expect(packageVersion.length).toBeGreaterThan(0);
  });
});
