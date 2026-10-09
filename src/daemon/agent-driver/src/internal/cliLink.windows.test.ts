import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeLaunchContext, fakePrepared } from "../testing/adapter-fixture.js";
import { prepareCliTransport } from "./cliTransport.js";
import { writeCliLink } from "./cliLink.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";

async function invoke(command: string, args: string[], cwd: string, shell: boolean,
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) {
  const child = spawnAgentProcess(command, args, { cwd, env: options.env ?? process.env, shell });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const closed = once(child, "close");
  if (options.stdin !== undefined) child.stdin?.end(options.stdin, "utf8");
  const timeout = setTimeout(() => { void killProcessTree(child.pid!).catch(() => {}); }, 30_000);
  try {
    await closed;
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: child.exitCode };
  } finally {
    clearTimeout(timeout);
    if (child.pid && isAlive(child.pid)) await killProcessTree(child.pid);
  }
}

describe.skipIf(process.platform !== "win32")("native Windows injected Node CLI", () => {
  it("executes a Node JS CLI through both its wrapper and actual transport env", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook Node CLI with spaces-"));
    const host = join(directory, "index.js");
    const marker = "alook-native-node-cli-ready";
    writeFileSync(host, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ marker: ${JSON.stringify(marker)}, args: process.argv.slice(2) }));\n`);
    const expected = JSON.stringify({ marker, args: ["--help"] });
    try {
      const control = await invoke(process.execPath, [host, "--help"], directory, false);
      console.log(JSON.stringify({ stage: "node-control", ...control }));
      expect(control.stdout).toBe(expected);
      expect(control.code).toBe(0);
      const bin = writeCliLink(join(directory, "wrapper"), "alook", host);
      const viaWrapper = await invoke(join(bin, "alook.cmd"), ["--help"], directory, true);
      console.log(JSON.stringify({ stage: "generated-wrapper", ...viaWrapper }));
      expect.soft(viaWrapper.stdout).toBe(expected);
      expect.soft(viaWrapper.code).toBe(0);
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: {
          ...fakePrepared({ base: process.env, platformProtected: { ALOOK_CLI: host }, networkProtected: { PATH: process.env.PATH } }),
          executablePath: host,
        },
      });
      const { spawnEnv } = await prepareCliTransport(ctx);
      expect.soft(spawnEnv.ALOOK_CLI).toMatch(/\.cmd$/i);
      expect.soft(spawnEnv.ALOOK_CLI).not.toContain("\\");
      const injected = await invoke(spawnEnv.ALOOK_CLI!, ["--help"], directory, true, { env: spawnEnv });
      console.log(JSON.stringify({ stage: "injected-cli", ...injected }));
      expect.soft(injected.stdout).toBe(expected);
      expect.soft(injected.code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);

  it("preserves UTF-8 stdin and exit codes through cmd and PowerShell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook Windows stdin with spaces-"));
    const host = join(directory, "index.cjs");
    const message = "Windows 中文回复✓ nonce-cli-165";
    writeFileSync(host, "if(process.argv.includes('--fail'))process.exit(23);console.log(require('node:fs').readFileSync(0,'utf8').trimEnd());\n");
    try {
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: {
          ...fakePrepared({ base: process.env, platformProtected: { ALOOK_CLI: host } }),
          executablePath: host,
        },
      });
      const { spawnEnv } = await prepareCliTransport(ctx);
      const cmd = await invoke(spawnEnv.ALOOK_CLI!, ["--stdin"], directory, true, { env: spawnEnv, stdin: message });
      console.log(JSON.stringify({ stage: "cmd-utf8-stdin", ...cmd }));
      expect(cmd.stdout).toBe(message);
      expect(cmd.code).toBe(0);
      const script = [
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "@'", message, "'@ | & $env:ALOOK_CLI --stdin",
        "exit $LASTEXITCODE",
      ].join("\r\n");
      const powershell = await invoke("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], directory, false, { env: spawnEnv });
      console.log(JSON.stringify({ stage: "powershell-utf8-stdin", ...powershell }));
      expect(powershell.stdout).toBe(message);
      expect(powershell.code).toBe(0);
      const failed = await invoke(spawnEnv.ALOOK_CLI!, ["--fail"], directory, true, { env: spawnEnv });
      expect(failed.code).toBe(23);
      const bashFailed = await invoke(process.env.ALOOK_NATIVE_BASH_PATH!, ["--noprofile", "--norc", "-c", '"$ALOOK_CLI" --fail'], directory, false, { env: spawnEnv });
      expect(bashFailed.code).toBe(23);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);


});

describe.skipIf(process.platform === "win32")("Windows Bash launcher logic on POSIX", () => {
  it("preserves startup, literal arguments and CLI-local environment through the public process authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook Bash's $path-"));
    try {
      const host = join(directory, "host.cjs");
      const startup = join(directory, "user startup.sh");
      writeFileSync(host, "console.log(JSON.stringify({ args: process.argv.slice(2), exclusion: process.env.MSYS2_ARG_CONV_EXCL, startup: process.env.USER_STARTUP_MARKER }));\n");
      writeFileSync(startup, "export USER_STARTUP_MARKER=loaded\n");
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: { ...fakePrepared({ base: { ...process.env, BASH_ENV: startup } }), executablePath: host },
      });
      const { spawnEnv } = await prepareCliTransport(ctx, {}, undefined, "win32");
      const result = await invoke("/bin/bash", ["--noprofile", "--norc", "-c", '"$ALOOK_CLI" --target "/server#0042/general" "中文✓"; test "${MSYS2_ARG_CONV_EXCL-unset}" = unset'], directory, false, { env: { ...spawnEnv, MSYS2_ARG_CONV_EXCL: undefined } });
      expect(JSON.parse(result.stdout)).toEqual({ args: ["--target", "/server#0042/general", "中文✓"], exclusion: "*", startup: "loaded" });
      expect(result.code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.ALOOK_NATIVE_CLI_PATH)("installed host CLI callback", () => {
  it("pulls, acknowledges and sends literal stdin through the injected product CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook candidate callback with spaces-"));
    const channel = "/windows-qa#0042/general";
    const requests: Array<{ method: string | undefined; path: string | undefined; body: Record<string, unknown>; authorized: boolean }> = [];
    const incoming = { seq: "#1", channel, sender: "@qa#0042", content: { text: "callback-inbox-nonce-165" }, time: "2026-10-09T00:00:00Z" };
    let sentCount = 0;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        const authorized = req.headers.authorization === "Bearer vch_windows_cli_fixture";
        requests.push({ method: req.method, path: req.url, body, authorized });
        res.setHeader("content-type", "application/json");
        if (!authorized) { res.writeHead(401).end(JSON.stringify({ error: "fixture authorization missing" })); return; }
        if (req.url === "/api/community/users/me/inbox/pull") {
          res.end(JSON.stringify({ messages: [incoming], hasMore: false, markedCount: 0 }));
        } else if (req.url === "/api/community/users/me/inbox/ack") {
          res.end(JSON.stringify({ applied: body.cursors, failed: [] }));
        } else if (req.url === "/api/community/channels/resolve/messages") {
          sentCount += 1;
          res.end(JSON.stringify({ state: "sent", message: { ...incoming, seq: `#${sentCount + 1}`, content: body.content } }));
        } else if (req.url === "/__alook/local/message-reminder") {
          res.end(JSON.stringify({ armed: false, reason: "disabled" }));
        } else {
          res.writeHead(404).end(JSON.stringify({ error: "unexpected fixture route" }));
        }
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: "invalid fixture request" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture TCP port");
      const voucherFile = join(directory, "voucher.txt");
      writeFileSync(voucherFile, "vch_windows_cli_fixture", { mode: 0o600 });
      const host = process.env.ALOOK_NATIVE_CLI_PATH!;
      const originalBashEnv = join(directory, "user startup.sh");
      writeFileSync(originalBashEnv, "export USER_STARTUP_MARKER=original-bash-env-loaded\n");
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: {
          ...fakePrepared({
            base: { ...process.env, BASH_ENV: originalBashEnv.replaceAll("\\", "/") },
            platformProtected: { ALOOK_ID: "agent_cli_fixture", ALOOK_CLI: host },
            networkProtected: { ALOOK_PROXY_URL: `http://127.0.0.1:${address.port}` },
            credentialSensitive: { ALOOK_PROXY_TOKEN_FILE: voucherFile },
          }),
          executablePath: host,
        },
      });
      const { spawnEnv } = await prepareCliTransport(ctx);
      const windows = process.platform === "win32";
      const pull = await invoke(spawnEnv.ALOOK_CLI!, ["inbox", "pull"], directory, windows, { env: spawnEnv });
      console.log(JSON.stringify({ stage: "candidate-inbox-pull", ...pull }));
      expect(JSON.parse(pull.stdout).success.messages[0].content.text).toBe(incoming.content.text);
      expect(JSON.parse(pull.stdout).success.acked).toBe(1);
      expect(pull.code).toBe(0);
      const message = "Windows 中文回复✓ nonce-product-cli-165";
      const sendArgs = ["message", "send", "--target", channel, "--reply", "1", "--stdin", "--remind-after", "0"];
      const send = await invoke(spawnEnv.ALOOK_CLI!, sendArgs, directory, windows, { env: spawnEnv, stdin: message });
      console.log(JSON.stringify({ stage: "candidate-stdin-send", ...send }));
      expect(JSON.parse(send.stdout).success.sent).toBe(`${channel}#2`);
      expect(send.code).toBe(0);
      const expectedBodies = [message];
      if (windows) {
        const script = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n@'\r\n" + message +
          `\r\n'@ | & $env:ALOOK_CLI message send --target '${channel}' --reply 1 --stdin --remind-after 0\r\nexit $LASTEXITCODE`;
        const powershell = await invoke("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64")], directory, false, { env: spawnEnv });
        console.log(JSON.stringify({ stage: "candidate-powershell-send", ...powershell }));
        expect(JSON.parse(powershell.stdout).success.sent).toBe(`${channel}#3`);
        expect(powershell.code).toBe(0);
        expectedBodies.push(message + "\r\n");
        const bashPath = process.env.ALOOK_NATIVE_BASH_PATH;
        expect(bashPath).toBeTruthy();
        const bashScript = join(directory, "send.sh");
        const nodeScript = join(directory, "native-path-control.cjs");
        const controlFile = join(directory, "native-path-control.json");
        writeFileSync(nodeScript, "require('node:fs').writeFileSync(process.argv[3], JSON.stringify({ arg: process.argv[2], startup: process.env.USER_STARTUP_MARKER, exclusion: process.env.MSYS2_ARG_CONV_EXCL ?? null }));\n");
        writeFileSync(bashScript, `"$ALOOK_CLI" message send --target '${channel}' --reply 1 --stdin --remind-after 0 <<'ALOOK_CLI_TEST_165'\n${message}\nALOOK_CLI_TEST_165\nstatus=$?\n'${process.execPath.replaceAll("\\", "/")}' '${nodeScript.replaceAll("\\", "/")}' /ordinary/path '${controlFile.replaceAll("\\", "/")}'\nexit "$status"\n`);
        const bash = await invoke(bashPath!, ["--noprofile", "--norc", bashScript.replaceAll("\\", "/")], directory, false, { env: spawnEnv });
        console.log(JSON.stringify({ stage: "candidate-git-bash-send", ...bash }));
        expect(JSON.parse(bash.stdout).success.sent).toBe(`${channel}#4`);
        expect(bash.code).toBe(0);
        const control = JSON.parse(readFileSync(controlFile, "utf8"));
        expect(control.startup).toBe("original-bash-env-loaded");
        expect(control.exclusion).toBe(process.env.MSYS2_ARG_CONV_EXCL ?? null);
        expect(control.arg.replaceAll("\\", "/")).toMatch(/^[A-Za-z]:\/.*\/ordinary\/path$/);
        expectedBodies.push(message + "\n");
      }
      const sends = requests.filter(req => req.path === "/api/community/channels/resolve/messages");
      expect(sends.map(req => req.body.content)).toEqual(expectedBodies.map(text => ({ text })));
      expect(sends.every(req => req.body.channel === channel && req.body.replyToSeq === 1 && typeof req.body.nonce === "string")).toBe(true);
      expect(requests.every(req => req.authorized && !("agentId" in req.body))).toBe(true);
      expect(requests.filter(req => req.path === "/api/community/users/me/inbox/ack").map(req => req.body.cursors))
        .toEqual([[{ channel, seq: 1 }]]);
      expect(requests).toHaveLength(2 + expectedBodies.length * 2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});
