import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const processAuthority = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }));
vi.mock("./killTree.js", () => ({
  spawnAgentProcess: processAuthority.spawn,
  killProcessTree: processAuthority.stop,
  SESSION_STOP_GRACE_MS: 2_000,
}));
import { SdkWorkerLane } from "./sdk-worker-lane.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.resetAllMocks();
});

function worker() {
  processAuthority.spawn.mockReturnValue(Object.assign(new EventEmitter(), {
    pid: 4_242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  }));
  const lane = new SdkWorkerLane(async () => ({ status: "healthy" }), {
    modulePath: "unused", cwd: process.cwd(), config: {}, probe: { includeModels: false },
  }, {});
  const directory = (lane as unknown as { directory: string }).directory;
  directories.push(directory);
  return { lane, directory };
}

it("retains worker files until process authority confirms termination", async () => {
  let finish!: () => void;
  processAuthority.stop.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  const { lane, directory } = worker();
  const stopping = lane.stop();
  expect(existsSync(directory)).toBe(true);
  finish();
  await stopping;
  expect(existsSync(directory)).toBe(false);
});

it("preserves termination failure and worker files when cleanup cannot complete", async () => {
  const failure = new Error("owned process did not close");
  processAuthority.stop.mockRejectedValue(failure);
  const { lane, directory } = worker();
  await expect(lane.stop()).rejects.toBe(failure);
  expect(existsSync(directory)).toBe(true);
  await expect(lane.stop()).rejects.toBe(failure);
  expect(processAuthority.stop).toHaveBeenCalledOnce();
});
