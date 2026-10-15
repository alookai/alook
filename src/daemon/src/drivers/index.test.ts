import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_BACKEND_IDS, getBuiltinBackendCapabilities } from "@alook/agent-driver";
import { getDriver } from "./index";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@alook/agent-driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/agent-driver")>();
  return { ...actual, createAgentDriverSdk: () => ({ probe }) };
});
beforeEach(() => probe.mockReset());

describe("daemon runtime probe intent", () => {
  it.each(BUILTIN_BACKEND_IDS)("separates %s installation from its native catalog without altering metadata", async (id) => {
    const catalog = { updateMode: "unsupported" as const, defaultModelId: "native", models: [{ id: "native", supportedReasoningEfforts: [{ value: "high", label: "High" }] }] };
    const installed = { status: "healthy", version: "native", capabilities: getBuiltinBackendCapabilities(id) };
    const discovered = { ...installed, reasoning: catalog };
    probe.mockResolvedValueOnce(installed).mockResolvedValueOnce(discovered);
    const driver = getDriver(id);
    expect(await driver.probe()).toBe(installed);
    expect(probe).toHaveBeenNthCalledWith(1, { backend: id, includeModels: false });
    expect(await driver.discoverModels()).toBe(discovered);
    expect(probe).toHaveBeenNthCalledWith(2, { backend: id });
    expect(driver.capabilities).toEqual(installed.capabilities);
  });
});
