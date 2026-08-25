import { beforeEach, describe, expect, it, vi } from "vitest";

const parseAsync = vi.hoisted(() => vi.fn());
const program = vi.hoisted(() => ({
  name: vi.fn(),
  description: vi.fn(),
  version: vi.fn(),
  enablePositionalOptions: vi.fn(),
  addCommand: vi.fn(),
  parseAsync,
}));
for (const key of ["name", "description", "version", "enablePositionalOptions"] as const) {
  program[key].mockReturnValue(program);
}

vi.mock("commander", () => ({
  Command: class {
    constructor() {
      return program;
    }
  },
}));
vi.mock("../src/commands/onboard.js", () => ({ onboardCommand: vi.fn(() => "onboard") }));
vi.mock("../src/commands/start.js", () => ({ startCommand: vi.fn(() => "start") }));
vi.mock("../src/commands/stop.js", () => ({ stopCommand: vi.fn(() => "stop") }));
vi.mock("../src/commands/update.js", () => ({ updateCommand: vi.fn(() => "update") }));
vi.mock("../src/commands/daemon.js", () => ({ daemonCommand: vi.fn(() => "daemon") }));

describe("app CLI entry", () => {
  beforeEach(() => {
    vi.resetModules();
    parseAsync.mockReset();
    program.addCommand.mockClear();
  });

  it.each([new Error("entry failed"), "string failure"])("reports parse failures without throwing (%s)", async (failure) => {
    parseAsync.mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    await import("../src/index.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith(failure instanceof Error ? failure.message : failure);
    expect(program.addCommand).toHaveBeenCalledTimes(5);
    process.exitCode = undefined;
  });
});
