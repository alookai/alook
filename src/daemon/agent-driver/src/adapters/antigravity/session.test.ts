import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinAgentDriverSdk, type AgentEvent, type BuiltinBackendSpecs } from "../../host.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";

describe.skipIf(process.platform === "win32")("Antigravity SDK prompt completion", () => {
  it.each(["error", "error-without-code", "error-string-code", "invalid", "cancelled", "interrupt", "end_turn", "max_tokens", "refusal", "max_turn_requests"])(
    "settles %s once, preserves queued work, and publishes only completed content",
    async (terminal) => {
      const directory = mkdtempSync(join(tmpdir(), "alook-antigravity-sdk-"));
      const executable = join(directory, "acp-fixture");
      const release = join(directory, "release");
      writeFileSync(executable, `#!${process.execPath}
const { createInterface } = require("node:readline");
const { existsSync } = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const update = (sessionUpdate, text) => send({ method: "session/update", params: { sessionId: "sdk-native", update: { sessionUpdate, content: { type: "text", text } } } });
let count = 0;
let root;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp" }, agentCapabilities: { loadSession: true } } });
  if (request.method === "session/new") send({ id: request.id, result: { sessionId: "sdk-native" } });
  if (request.method === "session/cancel") send({ id: root, result: { stopReason: "cancelled" } });
  if (request.method !== "session/prompt") return;
  root = request.id;
  count++;
  update("agent_message_chunk", count === 1 ? "first message" : "next message");
  update("agent_thought_chunk", count === 1 ? "first reasoning" : "next reasoning");
  if (count > 1) { send({ id: request.id, result: { stopReason: "end_turn" } }); return; }
  if (${JSON.stringify(terminal)} === "interrupt") return;
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    const terminal = ${JSON.stringify(terminal)};
    const reply = terminal === "error" ? { error: { code: -32603, message: "injected failure" } }
      : terminal === "error-without-code" ? { error: { message: "injected failure" } }
      : terminal === "error-string-code" ? { error: { code: "invalid", message: "injected failure" } }
      : { result: { stopReason: terminal } };
    send({ id: request.id, ...reply });
    send({ id: request.id, ...reply });
  }, 5);
});
`, { mode: 0o755 });
      const host = createFakeAgentDriverHost();
      const opened = await createBuiltinAgentDriverSdk({ host }).open({
        backend: "antigravity",
        config: { model: { kind: "default" }, command: executable },
        launch: { workingDirectory: directory, instructions: { format: "markdown", content: "" }, launchId: "sdk-fault" },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.session;
      const events: AgentEvent<BuiltinBackendSpecs, "antigravity">[] = [];
      const collecting = (async () => { for await (const event of session.events) events.push(event); })();
      try {
        expect(await session.start({ id: "first", kind: "user", text: "first" })).toMatchObject({ status: "accepted" });
        await vi.waitFor(() => expect(events.some((event) => event.type === "work_heartbeat")).toBe(true));
        expect(await session.send({ id: "second", kind: "user", text: "second" })).toMatchObject({ status: "queued" });
        if (terminal === "interrupt") {
          expect(await session.interrupt({ requestId: "cancel", reason: "test" })).toMatchObject({ status: "accepted" });
        } else {
          writeFileSync(release, "go");
        }
        await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2));
        const successful = ["end_turn", "max_tokens", "refusal", "max_turn_requests"].includes(terminal);
        expect(events.filter((event) => event.type === "assistant_message_completed").map((event) => event.text))
          .toEqual(successful ? ["first message", "next message"] : ["next message"]);
        expect(events.filter((event) => event.type === "assistant_reasoning_completed").map((event) => event.text))
          .toEqual(successful ? ["first reasoning", "next reasoning"] : ["next reasoning"]);
        expect(events.filter((event) => event.type === "turn_completed")).toMatchObject([
          { commandIds: ["first"], result: { outcome: terminal === "interrupt" ? "interrupted" : successful ? "success" : "failed" } },
          { commandIds: ["second"], result: { outcome: "success" } },
        ]);
        expect(events.filter((event) => event.type === "command_accepted").map((event) => event.commandId)).toEqual(["first", "second"]);
      } finally {
        await session.stop({ reason: "shutdown", forceAfterMs: 50 });
        await session.closed;
        await collecting;
        rmSync(directory, { recursive: true, force: true });
      }
      expect(host.releases).toHaveLength(1);
    },
  );
});
