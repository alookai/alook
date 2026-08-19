import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

describe("packed @alook/agent-driver", () => {
  it("shares the daemon version and installs with only its documented exports", { timeout: 120_000 }, async () => {
    expect(packageVersion(packageRoot)).toBe(packageVersion(join(repositoryRoot, "src/daemon")));

    const root = mkdtempSync(join(tmpdir(), "alook-agent-driver-pack-"));
    const fixture = join(root, "consumer");
    tempRoots.push(root);
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    await execFileAsync("pnpm", ["pack", "--pack-destination", root], {
      cwd: packageRoot,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const tarballName = readdirSync(root).find((name) => name.endsWith(".tgz"));
    if (!tarballName) throw new Error("agent-driver pack did not produce a tarball");
    const tarball = join(root, tarballName);

    await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    writeFileSync(join(root, "usage.ts"), `
import { createAgentDriverSdk } from "@alook/agent-driver";

const sdk = createAgentDriverSdk();
const opened = await sdk.open({
  backend: "codex",
  launch: {
    workingDirectory: ".",
    instructions: { format: "markdown", content: "Be concise." },
    launchId: "launch-example",
  },
  config: { model: { kind: "default" }, mode: "default" },
});
if (!opened.ok) throw new Error(opened.error.message);
const session = opened.session;
const observedText: string[] = [];
const eventsDone = (async () => {
  for await (const event of session.events) {
    if (event.type === "text_delta") observedText.push(event.text);
  }
})();
const receipt = await session.start({ id: "command-example", kind: "user", text: "Explain this repository." });
if (receipt.status === "rejected") throw new Error(receipt.reason);
await session.stop({ reason: "owner_request", forceAfterMs: 5_000 });
const result = await session.closed;
await eventsDone;
void { result, observedText };
`);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["usage.ts"],
    }));
    const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    await execFileAsync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { cwd: root });

    writeFileSync(join(root, "fake-cursor.mjs"), `
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "packed-session" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "packed-ok" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "packed-session" }));
`);
    const executable = process.platform === "win32"
      ? join(root, "fake-cursor.cmd")
      : join(root, "fake-cursor");
    if (process.platform === "win32") {
      writeFileSync(executable, "@node \"%~dp0\\fake-cursor.mjs\" %*\r\n");
    } else {
      writeFileSync(executable, `#!/usr/bin/env node\nawait import(${JSON.stringify(join(root, "fake-cursor.mjs"))});\n`);
      chmodSync(executable, 0o755);
    }
    writeFileSync(join(root, "runtime.mjs"), `
import { createAgentDriverSdk } from "@alook/agent-driver";
import { createFakeAgentDriverHost } from "@alook/agent-driver/testing";
const sdk = createAgentDriverSdk({ host: createFakeAgentDriverHost({
  environmentLayers: {
    base: process.env,
    hostStatic: {}, identityProtected: {}, platformProtected: {},
    runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
  },
}) });
const opened = await sdk.open({
  backend: "cursor",
  launch: { workingDirectory: ${JSON.stringify(fixture)}, instructions: { format: "markdown", content: "Packed." }, launchId: "packed-launch" },
  config: { model: { kind: "default" }, command: ${JSON.stringify(executable)} },
});
if (!opened.ok) throw new Error(opened.error.message);
const events = [];
const done = (async () => {
  for await (const event of opened.session.events) {
    events.push(event);
    if (event.type === "turn_completed") return;
  }
})();
const receipt = await opened.session.start({ id: "packed-command", kind: "user", text: "run" });
if (receipt.status !== "accepted") throw new Error(JSON.stringify(receipt));
await done;
await opened.session.stop({ reason: "owner_request", forceAfterMs: 1_000 });
await opened.session.closed;
if (!events.some((event) => event.type === "text_delta" && event.text === "packed-ok")) throw new Error("missing packed text event: " + JSON.stringify(events));
try {
  await import("@alook/agent-driver/internal/adapter");
  throw new Error("private subpath unexpectedly exported");
} catch (error) {
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
`);
    await execFileAsync(process.execPath, [join(root, "runtime.mjs")], { cwd: root });

    const declarationFiles = readdirSync(join(root, "node_modules/@alook/agent-driver/dist"), { recursive: true })
      .filter((name): name is string => typeof name === "string" && name.endsWith(".d.ts"));
    const declarations = declarationFiles
      .map((name) => readFileSync(join(root, "node_modules/@alook/agent-driver/dist", name), "utf8"))
      .join("\n");
    expect(declarations).not.toContain("@alook/daemon");
    expect(declarations).not.toContain("src/daemon/src");
  });
});
