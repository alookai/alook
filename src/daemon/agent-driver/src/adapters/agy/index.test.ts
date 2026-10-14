import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyDriver } from "./index.js";
import { createBuiltinAgentDriverSdk, type AgentEvent, type BuiltinBackendSpecs } from "../../host.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { isAlive, killProcessTree } from "../../internal/killTree.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const line = (value: unknown) => JSON.stringify(value);
const step = (index: number, extra: object = {}, id = "native") => line({ event: "step_update", step_update: {
  conversation_id: id, step_index: index, state: "DONE", step_type: "agent_response", ...extra,
} });
const result = (turns: number, extra: object = {}, id = "native") => line({ event: "result", result: {
  conversation_id: id, status: "SUCCESS", response: "complete", num_turns: turns, ...extra,
} });
function begin(driver: AgyDriver, index = 0, id = "native") {
  driver.encodeMessage("prompt");
  return driver.normalizeLine(step(index, { step_type: "user_input" }, id));
}

describe("agy native stream ownership", () => {
  it("uses native input identity, ignores other sessions and stale/duplicate terminals", () => {
    const driver = new AgyDriver();
    driver.encodeMessage("first");
    expect(driver.normalizeLine(line({ event: "init", conversation_id: "native" }))).toEqual([{ kind: "session_init", sessionId: "native" }]);
    expect(driver.normalizeLine(step(0, { step_type: "user_input" }))).toMatchObject([{ kind: "turn_owner", receipt: "agy:native:0" }]);
    expect(driver.normalizeLine(result(1, {}, "child"))).toEqual([]);
    expect(driver.normalizeLine(result(1))).toMatchObject([{ kind: "assistant_message_completed" }, { kind: "turn_end" }]);
    expect(driver.normalizeLine(result(1))).toEqual([]);
    expect(begin(driver, 3)).toMatchObject([{ kind: "turn_owner", receipt: "agy:native:3" }]);
    expect(driver.normalizeLine(step(0, { step_type: "user_input" }))).toEqual([]);
    expect(driver.normalizeLine(result(1))).toEqual([]);
    expect(driver.normalizeLine(result(2))).toHaveLength(2);
    expect(driver.encodeMessage("busy", null, { mode: "busy" })).toBeNull();
  });
  it("counts only live completed steps once and ignores cumulative result/history after resume", () => {
    const driver = new AgyDriver();
    driver.normalizeLine(line({ event: "init", conversation_id: "native" }));
    driver.encodeMessage("resume");
    const usage = { input_tokens: 7, output_tokens: 4, cache_read_tokens: 10, thinking_tokens: 3 };
    expect(driver.normalizeLine(step(2, { usage }))).toEqual([]);
    begin(driver, 9);
    expect(driver.normalizeLine(step(8, { usage }))).toEqual([]);
    const done = step(10, { usage });
    const events = driver.normalizeLine(done);
    expect(events).toMatchObject([{ kind: "telemetry", name: "token_usage", usage: { input: 7, output: 4, cache: 10 }, identity: { index: 10 } }]);
    expect(driver.normalizeLine(done)).toEqual([]);
    expect(driver.normalizeLine(result(4, { usage: { input_tokens: 99999 } })).filter((event) => event.kind === "telemetry")).toEqual([]);
    begin(driver, 12);
    expect(driver.normalizeLine(step(10, { usage }))).toEqual([]);
    expect(driver.normalizeLine(step(13, { usage: { output_tokens: 0 } }))).toMatchObject([{ usage: { input: null, output: 0, cache: null } }]);
  });
  it("keeps a tool live until its matching completed step without ending the root turn", () => {
    const driver = new AgyDriver();
    driver.normalizeLine(line({ event: "init", conversation_id: "native" }));
    begin(driver);
    expect(driver.normalizeLine(step(1, { step_type: "tool", state: "ACTIVE", tool_name: "bash", tool_info: { parameters: "ls" } }))).toEqual([{ kind: "tool_call", callId: "native:1", name: "bash", input: "ls" }]);
    expect(driver.normalizeLine(step(1, { step_type: "tool", state: "DONE", tool_name: "bash" }, "child"))).toEqual([]);
    expect(driver.normalizeLine(step(1, { step_type: "tool", tool_name: "bash" }))).toEqual([{ kind: "tool_output", callId: "native:1", name: "bash" }]);
    expect(driver.normalizeLine(result(1))).toMatchObject([{ kind: "assistant_message_completed" }, { kind: "turn_end" }]);
  });
  it.each(["ERROR", "CANCELLED", "TIMEOUT"])("discards partial content on %s and never treats it as success", (status) => {
    const driver = new AgyDriver();
    driver.normalizeLine(line({ event: "init", conversation_id: "native" }));
    begin(driver);
    driver.normalizeLine(step(1, { text_delta: "partial" }));
    expect(driver.normalizeLine(result(1, { status, error: "native failure" }))).toEqual([
      { kind: "error", message: "native failure" }, { kind: "turn_end", sessionId: "native", pendingContent: "discard" },
    ]);
  });
  it("rejects malformed streams, invalid input identity and unowned results", async () => {
    const invalid = new AgyDriver();
    expect(invalid.normalizeLine("broken")).toMatchObject([{ kind: "error" }]);
    expect(invalid.encodeMessage("after failure")).toBeNull();
    const driver = new AgyDriver();
    driver.normalizeLine(line({ event: "init", conversation_id: "native" }));
    driver.encodeMessage("prompt");
    expect(driver.normalizeLine(result(1))).toMatchObject([{ kind: "error" }]);
    expect(await driver.interrupt()).toBe(false);
    const badIndex = new AgyDriver();
    badIndex.normalizeLine(line({ event: "init", conversation_id: "native" }));
    badIndex.encodeMessage("prompt");
    expect(badIndex.normalizeLine(step(-1))).toMatchObject([{ kind: "error" }]);
  });
});

function fixture(mode = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "alook-agy-sdk-"));
  directories.push(directory);
  const executable = join(directory, "cli-fixture");
  writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('1.3.4');process.exit(0)}
if(process.argv.includes('--help')){console.error('--input-format --output-format stream-json --conversation');process.exit(0)}
fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));
const emit=x=>console.log(JSON.stringify(x));
const requested=process.argv[process.argv.indexOf('--conversation')+1];
const resumed=process.argv.includes('--conversation');
const id=${JSON.stringify(mode)}==='mismatch'?'substitute':resumed?requested:'native';
if(${JSON.stringify(mode)}==='auth'){emit({event:'result',result:{conversation_id:'',status:'ERROR',error:'authentication required',num_turns:0}});process.exit(1)}
emit({event:'init',conversation_id:id});
let turn=resumed?3:0;let index=resumed?9:0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);fs.appendFileSync('inputs.jsonl',JSON.stringify(input)+'\\n');turn++;
 emit({event:'step_update',step_update:{conversation_id:id,step_index:index,state:'DONE',step_type:'user_input'}});
 const done=()=>{
  const update={event:'step_update',step_update:{conversation_id:id,step_index:index+1,state:'DONE',step_type:'agent_response',text_delta:'reply '+turn,usage:{input_tokens:7,output_tokens:4,cache_read_tokens:10}}};
  emit(update);emit(update);
  const result={event:'result',result:{conversation_id:id,status:'SUCCESS',response:'reply '+turn,num_turns:turn,usage:{input_tokens:99999}}};
  emit(result);emit(result);index+=3;
 };
 if(!resumed&&turn===1){const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);done()}},5)}else done();
});
`, { mode: 0o755 });
  return { directory, executable };
}

describe.skipIf(process.platform === "win32")("agy registered SDK with a real fixture process", () => {
  it("reports a failed initial input write, fences further input and releases its process", async () => {
    const f = fixture();
    const driver = new AgyDriver();
    expect(await driver.probe(f.executable)).toEqual({ status: "healthy", version: "1.3.4" });
    const ctx = fakeLaunchContext("agy", f.directory);
    const { process: child } = await driver.spawn({ ...ctx, backend: "agy", config: { ...ctx.config, runtimeConfig: { model: { kind: "default" }, command: f.executable } } });
    const closed = once(child, "close");
    const write = vi.spyOn(child.stdin!, "write").mockImplementation(() => { throw new Error("closed input"); });
    try {
      expect(driver.normalizeLine(line({ event: "init", conversation_id: "native" }))).toEqual([{ kind: "error", message: "Antigravity CLI input is unavailable" }]);
      expect(driver.encodeMessage("must not send")).toBeNull();
      await closed;
      expect(isAlive(child.pid!)).toBe(false);
    } finally { write.mockRestore(); if (child.pid && isAlive(child.pid)) await killProcessTree(child.pid, { graceMs: 10 }); }
  });
  it("drains ten busy inputs exactly once in order through one persistent process", async () => {
    const f = fixture();
    const opened = await createBuiltinAgentDriverSdk({ host: createFakeAgentDriverHost() }).open({ backend: "agy",
      config: { model: { kind: "default" }, command: f.executable },
      launch: { workingDirectory: f.directory, instructions: { format: "markdown", content: "" }, launchId: "agy-burst" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: AgentEvent<BuiltinBackendSpecs, "agy">[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    try {
      await session.start({ id: "0", kind: "user", text: "0" });
      const receipts = await Promise.all(Array.from({ length: 9 }, (_, i) => session.send({ id: String(i + 1), kind: "user", text: String(i + 1) })));
      expect(receipts.every((receipt) => receipt.status === "queued")).toBe(true);
      writeFileSync(join(f.directory, "release"), "go");
      await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(10));
      expect(events.filter((event) => event.type === "command_accepted").map((event) => event.commandId)).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
      expect(events.filter((event) => event.type === "assistant_message_completed").map((event) => event.text)).toEqual(Array.from({ length: 10 }, (_, i) => `reply ${i + 1}`));
      expect(events.filter((event) => event.type === "token_usage")).toHaveLength(10);
      expect(session.snapshot().diagnostics.metrics.physicalOpenCount).toBe(1);
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 10 }); await session.closed; await collecting; }
  });
  it("queues a busy input, reuses one process, preserves text/usage, and stops through existing authority", async () => {
    const f = fixture();
    const host = createFakeAgentDriverHost();
    const opened = await createBuiltinAgentDriverSdk({ host }).open({ backend: "agy",
      config: { model: { kind: "named", name: "chosen-model" }, reasoningEffort: "high", command: f.executable },
      launch: { workingDirectory: f.directory, instructions: { format: "markdown", content: "standing" }, launchId: "agy-sdk" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: AgentEvent<BuiltinBackendSpecs, "agy">[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    try {
      expect(await session.start({ id: "first", kind: "user", text: "first" })).toMatchObject({ status: "accepted" });
      expect(await session.send({ id: "second", kind: "user", text: "second" })).toMatchObject({ status: "queued" });
      expect(await session.interrupt({ requestId: "unsupported", reason: "test" })).toMatchObject({ status: "not_running" });
      writeFileSync(join(f.directory, "release"), "go");
      await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2));
      expect(events.filter((event) => event.type === "assistant_message_completed").map((event) => event.text)).toEqual(["reply 1", "reply 2"]);
      expect(events.filter((event) => event.type === "token_usage").map((event) => event.usage)).toEqual([{ input: 7, output: 4, cache: 10 }, { input: 7, output: 4, cache: 10 }]);
      const inputs = readFileSync(join(f.directory, "inputs.jsonl"), "utf8").trim().split("\n").map((row) => JSON.parse(row));
      expect(inputs[0].message.content).toContain("standing");
      expect(inputs[1]).toEqual({ event: "user", message: { content: "second" } });
      expect(session.snapshot().diagnostics.metrics.physicalOpenCount).toBe(1);
      expect(JSON.parse(readFileSync(join(f.directory, "argv.json"), "utf8"))).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "--model", "chosen-model", "--effort", "high"]));
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 10 }); await session.closed; await collecting; }
    expect(host.releases).toHaveLength(1);
  });
  it.each(["resume", "mismatch", "auth"])("handles %s without replacing a saved conversation", async (mode) => {
    const f = fixture(mode);
    const opened = await createBuiltinAgentDriverSdk({ host: createFakeAgentDriverHost() }).open({ backend: "agy",
      config: { model: { kind: "default" }, command: f.executable },
      launch: { workingDirectory: f.directory, instructions: { format: "markdown", content: "" }, launchId: mode, resumeSessionId: "saved-native" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: AgentEvent<BuiltinBackendSpecs, "agy">[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    try {
      const receipt = await session.start({ id: "resume", kind: "user", text: "resume" });
      expect(receipt.status).toBe(mode === "resume" ? "accepted" : "rejected");
      if (mode === "resume") {
        await vi.waitFor(() => expect(events.some((event) => event.type === "turn_completed")).toBe(true));
        expect(session.snapshot().backendSessionId).toBe("saved-native");
        expect(events.filter((event) => event.type === "token_usage")).toMatchObject([{ usage: { input: 7, output: 4, cache: 10 }, identity: { index: 10 } }]);
      } else {
        expect(events.some((event) => event.type === "assistant_message_completed")).toBe(false);
        expect(existsSync(join(f.directory, "inputs.jsonl"))).toBe(false);
        if (mode === "auth") expect(receipt).toMatchObject({ error: { message: expect.stringContaining("Run the configured Antigravity CLI in a terminal, complete sign-in, then retry") } });
      }
      expect(JSON.parse(readFileSync(join(f.directory, "argv.json"), "utf8"))).toEqual(expect.arrayContaining(["--conversation", "saved-native"]));
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 10 }); await session.closed; await collecting; }
  });
});
