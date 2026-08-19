import { describe, it, expect } from "vitest";
import { getDriver, listRuntimeIds, type RuntimeId } from "./index";
import type { DriverCapabilities } from "../types";

/**
 * Every driver declares which `RuntimeConfig` fields it actually consumes,
 * per the plan's capability matrix. This test pins that declaration so a
 * silent drift (e.g. someone adds `reasoningEffort` to a driver's `buildArgs`
 * without updating `capabilities`) trips CI.
 */
const EXPECTED: Record<RuntimeId, DriverCapabilities> = {
  claude:      { reasoningEffort: true,  fastMode: true,  disallowedTools: true,  command: true, sessionResumeMode: "by-id" },
  codex:       { reasoningEffort: true,  fastMode: true,  disallowedTools: false, command: true, sessionResumeMode: "by-id" },
  cursor:      { reasoningEffort: false, fastMode: false, disallowedTools: false, command: true, sessionResumeMode: "by-id" },
  opencode:    { reasoningEffort: false, fastMode: false, disallowedTools: false, command: true, sessionResumeMode: "by-id" },
  pi:          { reasoningEffort: true,  fastMode: false, disallowedTools: false, command: true, sessionResumeMode: "by-id" },
};

describe("driver.capabilities", () => {
  it.each(listRuntimeIds())("%s declares the expected capability record", (id) => {
    const driver = getDriver(id);
    expect(driver.capabilities).toEqual(EXPECTED[id]);
  });
});
