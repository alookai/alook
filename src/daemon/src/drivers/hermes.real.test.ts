import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HermesDriver } from "./hermes";
import { HermesEventNormalizer } from "./hermesEventNormalizer";
import { buildHermesArgs } from "./hermesLaunch";

/**
 * REAL-BINARY integration test (opt-in via ALOOK_HERMES_REAL_TEST=1).
 *
 * Unlike hermes.test.ts (which spawns a fake shim), this test drives the
 * ACTUAL `hermes` CLI on PATH against a local OpenAI-compatible proxy, using
 * the exact argv the driver builds. It proves the full loop end-to-end:
 *   spawn -> real hermes runs a turn -> its -Q stdout is normalized ->
 *   a `text` + `turn_end` event is produced (no hang, turn actually ends).
 *
 * Skipped unless ALOOK_HERMES_REAL_TEST=1 and HERMES_BASE_URL points at a
 * live proxy — so upstream CI (no local proxy) skips it, but a developer with
 * Hermes running can prove the driver against the genuine binary.
 */
const RUN = process.env.ALOOK_HERMES_REAL_TEST === "1" && !!process.env.HERMES_BASE_URL;

describe.skipIf(!RUN)("HermesDriver — REAL hermes binary end-to-end", () => {
  const events: ReturnType<HermesEventNormalizer["normalizeLine"]> = [];
  const norm = new HermesEventNormalizer();
  let out = "";

  it("spawns real hermes, gets a response, and the turn ends (no hang)", async () => {
    const driver = new HermesDriver();
    // Minimal LaunchContext — real run needs a credentialProxy like any CLI
    // runtime; we can't mint one here, so we call buildHermesArgs + spawn the
    // binary directly to validate the argv + output shape the daemon would use.
    const f = { model: "nous", fastMode: false, envVars: {}, providerEnv: {} };
    const ctx = {
      agentId: "real-test",
      workingDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "hermes-real-")),
      standingPrompt: "You are a test agent.",
      prompt: "Reply with exactly: REAL_HERMES_OK",
      config: { runtimeConfig: { version: 1, runtime: "hermes", model: { kind: "named", name: "nous" }, mode: { kind: "default" } } },
    } as unknown as ConstructorParameters<typeof HermesDriver>[0] extends never ? never : any;

    const spec = buildHermesArgs("hermes", ctx, f, {});
    const proc = spawn(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: { ...process.env, HERMES_QUIET: "1", HERMES_INTERACTIVE: "0" },
      shell: process.platform === "win32",
    });

    await new Promise<void>((resolve) => {
      proc.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        for (const line of d.toString().split("\n")) {
          if (line.trim()) for (const e of norm.normalizeLine(line.trim(), null)) events.push(e);
        }
      });
      proc.on("close", () => resolve());
      setTimeout(resolve, 90000); // hard cap so a broken run can't hang CI forever
    });

    expect(out).toContain("REAL_HERMES_OK");
    expect(events.some((e) => e.kind === "text")).toBe(true);
    // The critical real-world assertion: the turn ENDS (turn_end fires) even
    // though real Hermes -Q emits no session_id footer.
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
  }, 100000);
});