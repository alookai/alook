import { describe, it, expect } from "vitest";
import { HermesDriver } from "./hermes";
import { HermesEventNormalizer } from "./hermesEventNormalizer";
import { buildHermesArgs, resolveHermesLaunchCommand } from "./hermesLaunch";
import type { LaunchContext } from "../types";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("HermesDriver — interface contract", () => {
  const driver = new HermesDriver();

  it("implements the Driver interface fields", () => {
    expect(driver.id).toBe("hermes");
    expect(driver.lifecycle.kind).toBe("per_turn");
    expect(driver.terminateProcessOnTurnEnd).toBe(true);
    expect(driver.deferSpawnUntilMessage).toBe(true);
    expect(driver.supportsStdinNotification).toBe(false);
    expect(driver.busyDeliveryMode).toBe("none");
    expect(driver.session.recovery).toBe("resume_or_fresh");
  });

  it("does not accept mid-session stdin messages", () => {
    expect(driver.encodeStdinMessage("hi", null)).toBeNull();
  });

  it("defers system-task wakes (no process spawn)", () => {
    expect(driver.shouldDeferWakeMessage({ type: "system" })).toBe(true);
    expect(driver.shouldDeferWakeMessage({ type: "user" })).toBe(false);
  });
});

describe("HermesEventNormalizer — quiet-mode transcript parsing", () => {
  const norm = new HermesEventNormalizer();

  it("emits text events for response lines", () => {
    expect(norm.normalizeLine("Here is the fix.", null)).toEqual([
      { kind: "text", text: "Here is the fix." },
    ]);
  });

  it("treats a session_id footer as turn_end + session_init", () => {
    const evs = norm.normalizeLine("session_id: abc123", null);
    expect(evs).toContainEqual({ kind: "session_init", sessionId: "abc123" });
    expect(evs).toContainEqual({ kind: "turn_end", sessionId: "abc123" });
    expect(norm.currentSessionId).toBe("abc123");
  });

  it("accepts alternate footer spellings", () => {
    expect(norm.normalizeLine("Session ID: xyz", null)).toContainEqual({
      kind: "session_init",
      sessionId: "xyz",
    });
    expect(norm.normalizeLine("session: qwe", null)).toContainEqual({
      kind: "session_init",
      sessionId: "qwe",
    });
  });

  it("emits an error event for error lines", () => {
    const evs = norm.normalizeLine("Error: something failed", null);
    expect(evs.some((e) => e.kind === "error")).toBe(true);
    expect(evs.some((e) => e.kind === "turn_end")).toBe(true);
  });

  it("ignores blank lines", () => {
    expect(norm.normalizeLine("   ", null)).toEqual([]);
  });

  it("multi-line response + footer collapses into one finished turn", () => {
    const evs = [
      "line one",
      "line two",
      "session_id: s1",
    ].flatMap((l) => norm.normalizeLine(l, null));
    const texts = evs.filter((e) => e.kind === "text").map((e) => (e as any).text);
    expect(texts).toEqual(["line one", "line two"]);
    expect(evs.some((e) => e.kind === "turn_end")).toBe(true);
    expect(evs.filter((e) => e.kind === "session_init")).toHaveLength(1);
  });
});

describe("buildHermesArgs — launch argument assembly", () => {
  const ctx = {
    agentId: "a1",
    workingDirectory: "/tmp/work",
    standingPrompt: "sys",
    prompt: "do the thing",
    config: {
      runtimeConfig: {
        version: 1,
        runtime: "hermes",
        model: { kind: "named", name: "tencent/hy3:free" },
        mode: { kind: "default" },
      },
    },
  } as unknown as LaunchContext;

  it("produces the canonical quiet-mode chat invocation", () => {
    const f = { model: "tencent/hy3:free", fastMode: false, envVars: {}, providerEnv: {} };
    const spec = buildHermesArgs("hermes", ctx, f, {});
    expect(spec.args).toContain("chat");
    expect(spec.args).toContain("-q");
    // On Windows the prompt is quoted (shell spawn doesn't re-quote spaced
    // args); on POSIX it stays unquoted. Assert the prompt is present either way.
    const isWin = process.platform === "win32";
    expect(spec.args).toContain(isWin ? `"do the thing"` : "do the thing");
    expect(spec.args).toContain("-Q");
    expect(spec.args).toContain("--pass-session-id");
    expect(spec.args).toContain("--model");
    expect(spec.args).toContain("tencent/hy3:free");
    expect(spec.args).toContain("--yolo");
  });

  it("adds --resume when a sessionId is present", () => {
    const ctx2 = { ...ctx, config: { ...ctx.config, sessionId: "prev-session" } } as unknown as LaunchContext;
    const f = { model: undefined, fastMode: false, envVars: {}, providerEnv: {} };
    const spec = buildHermesArgs("hermes", ctx2, f, {});
    expect(spec.args).toContain("--resume");
    expect(spec.args).toContain("prev-session");
  });

  it("respects ALOOK_HERMES_PROVIDER and ALOOK_HERMES_NO_YOLO", () => {
    const prev = process.env.ALOOK_HERMES_PROVIDER;
    const prevNoYolo = process.env.ALOOK_HERMES_NO_YOLO;
    process.env.ALOOK_HERMES_PROVIDER = "nous";
    process.env.ALOOK_HERMES_NO_YOLO = "1";
    const f = { model: undefined, fastMode: false, envVars: {}, providerEnv: {} };
    const spec = buildHermesArgs("hermes", ctx, f, {});
    expect(spec.args).toContain("--provider");
    expect(spec.args).toContain("nous");
    expect(spec.args).not.toContain("--yolo");
    if (prev === undefined) delete process.env.ALOOK_HERMES_PROVIDER;
    else process.env.ALOOK_HERMES_PROVIDER = prev;
    if (prevNoYolo === undefined) delete process.env.ALOOK_HERMES_NO_YOLO;
    else process.env.ALOOK_HERMES_NO_YOLO = prevNoYolo;
  });
});

describe("resolveHermesLaunchCommand", () => {
  it("uses host-supplied cliPath when it exists, else 'hermes'", () => {
    const tmp = path.join(os.tmpdir(), `hermes-bin-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmp, "#!/bin/sh\n");
    expect(resolveHermesLaunchCommand(tmp)).toBe(tmp);
    fs.unlinkSync(tmp);
    expect(resolveHermesLaunchCommand(undefined)).toBe("hermes");
  });
});
