import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";
import { flagOrEnv, resolveAgentId } from "./flags.js";

function makeCmd(opts: Record<string, string>) {
  return { opts: () => opts } as any;
}

afterEach(() => {
  delete process.env.TEST_FLAG_ENV;
});

describe("flagOrEnv", () => {
  it("returns flag value when set", () => {
    const cmd = makeCmd({ myFlag: "from-flag" });
    expect(flagOrEnv(cmd, "myFlag", "TEST_FLAG_ENV", "default")).toBe(
      "from-flag",
    );
  });

  it("returns env var when flag not set", () => {
    process.env.TEST_FLAG_ENV = "from-env";
    const cmd = makeCmd({});
    expect(flagOrEnv(cmd, "myFlag", "TEST_FLAG_ENV", "default")).toBe(
      "from-env",
    );
  });

  it("returns fallback when neither set", () => {
    const cmd = makeCmd({});
    expect(flagOrEnv(cmd, "myFlag", "TEST_FLAG_ENV", "default")).toBe(
      "default",
    );
  });

  it("flag takes priority over env var", () => {
    process.env.TEST_FLAG_ENV = "from-env";
    const cmd = makeCmd({ myFlag: "from-flag" });
    expect(flagOrEnv(cmd, "myFlag", "TEST_FLAG_ENV", "default")).toBe(
      "from-flag",
    );
  });
});

describe("resolveAgentId", () => {
  const originalEnv = process.env.ALOOK_AGENT_ID;

  beforeEach(() => {
    delete process.env.ALOOK_AGENT_ID;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ALOOK_AGENT_ID = originalEnv;
    } else {
      delete process.env.ALOOK_AGENT_ID;
    }
  });

  it("returns flag value when both flag and env are set (flag wins)", () => {
    process.env.ALOOK_AGENT_ID = "env_agent";
    expect(resolveAgentId({ agent_id: "flag_agent" })).toBe("flag_agent");
  });

  it("returns env value when only env is set", () => {
    process.env.ALOOK_AGENT_ID = "env_agent";
    expect(resolveAgentId({})).toBe("env_agent");
  });

  it("calls process.exit(1) when neither is provided", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveAgentId({})).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Error: --agent_id is required (or set ALOOK_AGENT_ID env var)",
    );

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
