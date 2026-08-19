import { describe, expect, it, vi } from "vitest";
import { createDefaultAgentDriverHost } from "./default-host.js";

describe("createDefaultAgentDriverHost", () => {
  it("prepares an isolated environment snapshot and forwards raw output", async () => {
    const environment = { TEST_VALUE: "before" };
    const onRawOutput = vi.fn();
    const host = createDefaultAgentDriverHost({ environment, onRawOutput });
    environment.TEST_VALUE = "after";

    const prepared = await host.prepareExecution({ backend: "claude", launchId: "launch", workingDirectory: "/tmp" });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error("expected a prepared resource");
    expect(prepared.resource.environmentLayers.base).toEqual({ TEST_VALUE: "before" });
    await expect(prepared.resource.release({
      reason: "normal",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    })).resolves.toBeUndefined();

    const event = { backend: "claude", launchId: "launch", stream: "stdout" as const, text: "line" };
    host.onRawOutput(event);
    expect(onRawOutput).toHaveBeenCalledWith(event);
    expect(host.now()).toBeTypeOf("number");
    expect(host.createId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("works with default options and without a raw-output subscriber", async () => {
    const host = createDefaultAgentDriverHost();
    const prepared = await host.prepareExecution({ backend: "codex", launchId: "launch", workingDirectory: "/tmp" });
    expect(prepared.ok).toBe(true);
    expect(() => host.onRawOutput({ backend: "codex", launchId: "launch", stream: "stderr", text: "line" }))
      .not.toThrow();
  });
});
