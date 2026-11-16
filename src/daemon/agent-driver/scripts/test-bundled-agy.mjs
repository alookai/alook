import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleUrl = process.argv[2];
if (!moduleUrl) throw new Error("Pass the installed daemon module URL");
const { createAgentDriverSdk } = await import(moduleUrl);
const sqliteModule = createRequire(moduleUrl).resolve("better-sqlite3");
const root = realpathSync(mkdtempSync(join(tmpdir(), "alook-packed-agy-")));
const gemini = join(root, "gemini");
mkdirSync(gemini);
const command = join(root, process.platform === "win32" ? "agy.cmd" : "agy");
const program = join(root, "agy.cjs");
const pids = join(root, "pids");
const native = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const Database = require(${JSON.stringify(sqliteModule)});
const home = process.argv[process.argv.indexOf("--gemini-dir") + 1];
const directory = path.join(home, "antigravity-cli", "conversations");
fs.mkdirSync(directory, { recursive: true });
const db = new Database(path.join(directory, "native-pack.db"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS executor_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY,has_subtrajectory INTEGER)");
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\n");
const pending = [];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
function finish(reason) {
  const idx = db.prepare("SELECT count(*) n FROM executor_metadata").get().n;
  const executionId = "packed-" + idx;
  const data = Buffer.concat([
    Buffer.from([8, reason, 74, executionId.length]), Buffer.from(executionId),
    ...(reason === 1 ? [Buffer.from([98, 7]), Buffer.from("private")] : [])
  ]);
  db.prepare("INSERT INTO executor_metadata VALUES(?,?)").run(idx, data);
  for (const id of pending.splice(0)) result(id, {
    stopReason: "end_turn",
    usage: { inputTokens: 25, outputTokens: 5, cachedReadTokens: 4, thoughtTokens: 3 }
  });
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") result(message.id, {
    protocolVersion: 1,
    agentInfo: { name: "Antigravity ACP Server", version: "1.4.12" },
    agentCapabilities: {
      loadSession: true, sessionCapabilities: { resume: {}, list: {} },
      _meta: { antigravity: { systemPrompt: { append: true } } }
    }
  });
  else if (message.method === "session/new" || message.method === "session/resume") {
    result(message.id, { sessionId: "native-pack", configOptions: [] });
  } else if (message.method === "session/list") {
    result(message.id, { sessions: [{ sessionId: "native-pack", cwd: process.cwd() }] });
  } else if (message.method === "session/prompt") {
    pending.push(message.id);
    const text = message.params.prompt[0].text;
    send({ method: "session/update", params: { sessionId: "native-pack", update: {
      sessionUpdate: "user_message_chunk", content: { type: "text", text }
    } } });
    if (text === "second") finish(1);
    else if (text === "recovered") finish(4);
  }
});
process.on("SIGTERM", () => { db.close(); process.exit(0); });
`;
writeFileSync(program, native);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(command, process.platform === "win32"
  ? `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`
  : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(program)} "$@"\n`, { mode: 0o755 });
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|comspec|temp|tmp|localappdata)$/i.test(key))),
  HOME: root, USERPROFILE: root, GEMINI_HOME: gemini,
};
let releases = 0;
const host = {
  prepareExecution: async () => ({ ok: true, resource: {
    environmentLayers: {
      base: environment, hostStatic: {}, identityProtected: {}, platformProtected: {},
      runtimeProtected: {}, networkProtected: {}, credentialSensitive: {},
    },
    release: async () => { releases++; },
  } }),
  onRawOutput() {}, now: Date.now, createId: randomUUID,
};
const sdk = createAgentDriverSdk({ host });
const sessions = [];
const results = [];
const closed = [];
async function wait(test) {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for packed agy session");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function open(resume) {
  const opened = await sdk.open({
    backend: "agy", config: { command, model: { kind: "default" } },
    launch: {
      workingDirectory: root, instructions: { format: "markdown", content: "standing" },
      launchId: randomUUID(), ...(resume ? { resumeSessionId: resume } : {}),
    },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const session = opened.session;
  const events = [];
  const collecting = (async () => { for await (const event of session.events) events.push(event); })();
  sessions.push({ session, collecting });
  return { session, events, collecting };
}
async function stop({ session, collecting }) {
  await session.stop({ reason: "shutdown", forceAfterMs: 2000 });
  const result = await session.closed;
  await collecting;
  assert.equal(result.outcome, "stopped");
  assert.equal(result.cleanup.status, "released");
  closed.push(result.outcome);
}
let failure;
try {
  const first = await open();
  const { session, events } = first;
  assert.equal((await session.start({ id: "first", kind: "user", text: "first" })).status, "accepted");
  assert.equal((await session.send({ id: "second", kind: "user", text: "second" })).delivery, "steer");
  await wait(() => session.snapshot().state === "idle");
  const completed = () => events.filter(event => event.type === "turn_completed");
  assert.equal(completed().length, 1);
  assert.equal(completed()[0].result.outcome, "failed");
  await session.send({ id: "third", kind: "user", text: "recovered" });
  await wait(() => completed().length === 2);
  assert.equal(completed()[1].result.outcome, "success");
  const id = session.snapshot().backendSessionId;
  results.push(...completed().map(event => event.result.outcome));
  await stop(first);
  const resumed = await open(id);
  assert.equal((await resumed.session.start({ id: "resumed", kind: "user", text: "recovered" })).status, "accepted");
  await wait(() => resumed.session.snapshot().state === "idle");
  assert.equal(resumed.events.find(event => event.type === "turn_completed").result.outcome, "success");
  results.push("success");
  await stop(resumed);
  const captured = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.equal(captured.length, 2);
  for (const pid of captured) assert.throws(() => process.kill(pid, 0));
  assert.equal(releases, 2);
  console.log(JSON.stringify({
    node: process.version, abi: process.versions.modules, results, closed, releases,
    capturedProcesses: captured.length, allDead: true,
  }));
} catch (error) {
  failure = error;
} finally {
  const cleanup = await Promise.allSettled(sessions.map(async ({ session, collecting }) => {
    let stopFailure;
    try { await session.stop({ reason: "shutdown", forceAfterMs: 0 }); }
    catch (error) { stopFailure = error; }
    await session.closed;
    await collecting;
    if (stopFailure) throw stopFailure;
  }));
  failure ??= cleanup.find(result => result.status === "rejected")?.reason;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (error) { failure ??= error; }
}
if (failure) throw failure;
