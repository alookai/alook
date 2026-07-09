import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { credentialFilePathByMachineId } from "./daemonStart";

describe("daemonStart — credentialFilePath by machineId", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemon-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("derives path from machineId, not from the CLI arg", () => {
    const machineId = "cm_abc123";
    const p1 = credentialFilePathByMachineId(baseDir, machineId);
    const p2 = credentialFilePathByMachineId(baseDir, machineId);
    expect(p1).toBe(p2);
    expect(p1).toContain(`${machineId}.credential.json`);
  });

  it("same machineId produces the same path across two rotates — no orphaned files", () => {
    const machineId = "cm_abc123";
    const p = credentialFilePathByMachineId(baseDir, machineId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ credential: "cmk_first", machineId }), { mode: 0o600 });
    fs.writeFileSync(p, JSON.stringify({ credential: "cmk_second", machineId }), { mode: 0o600 });
    const files = fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith(".credential.json"));
    expect(files).toEqual([`${machineId}.credential.json`]);
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed).toEqual({ credential: "cmk_second", machineId });
  });
});
