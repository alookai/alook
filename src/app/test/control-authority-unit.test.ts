import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  mode: "directory" as "directory" | "file" | "symlink",
  uid: process.getuid?.() ?? 0,
  socket: undefined as EventEmitter & Record<string, ReturnType<typeof vi.fn>> | undefined,
}));

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  lstatSync: vi.fn(() => ({
    isDirectory: () => fixture.mode === "directory",
    isSymbolicLink: () => fixture.mode === "symlink",
    uid: fixture.uid,
  })),
  mkdirSync: vi.fn(),
}));
vi.mock("node:net", () => ({
  createConnection: vi.fn(() => {
    const socket = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    socket.destroy = vi.fn();
    socket.setTimeout = vi.fn();
    socket.write = vi.fn();
    fixture.socket = socket;
    return socket;
  }),
}));
vi.mock("../src/lib/constants.js", () => ({ CONTROL_DIR: "/private/control" }));

import { createControlEndpoint, requestAuthority } from "../src/lib/control-authority.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  fixture.mode = "directory";
  fixture.uid = process.getuid?.() ?? 0;
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

describe("control authority unit edges", () => {
  it("uses a private named pipe on Windows", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    expect(createControlEndpoint("run", "web", "token")).toMatch(/^\\\\\.\\pipe\\alook-app-/);
  });

  it.each(["file", "symlink"] as const)("rejects a private control path that is a %s", (mode) => {
    fixture.mode = mode;
    expect(() => createControlEndpoint("run", "web", "token")).toThrow("not a directory");
  });

  it("rejects a control directory owned by another user", () => {
    fixture.uid = (process.getuid?.() ?? 0) + 1;
    expect(() => createControlEndpoint("run", "web", "token")).toThrow("owned by another user");
  });

  it("settles an authority request only once", async () => {
    const pending = requestAuthority({ pid: 1, endpoint: "endpoint", token: "token" }, "status");
    fixture.socket!.emit("connect");
    fixture.socket!.emit("data", Buffer.from(JSON.stringify({
      ok: true,
      runId: "run",
      service: "web",
      supervisorPid: 1,
      childState: "running",
    }) + "\n"));
    fixture.socket!.emit("error", new Error("late error"));
    await expect(pending).resolves.toMatchObject({ runId: "run" });
  });
});
