import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const runServiceSupervisor = vi.hoisted(() => vi.fn());

vi.mock("../src/service-supervisor-runtime.js", () => ({ runServiceSupervisor }));

describe("service supervisor entry", () => {
  beforeEach(() => {
    vi.resetModules();
    runServiceSupervisor.mockClear();
  });

  it("always boots the built-in production runtime", async () => {
    await import("../src/service-supervisor.js");
    expect(runServiceSupervisor).toHaveBeenCalledOnce();
    expect(runServiceSupervisor).toHaveBeenCalledWith();
  });

  it("keeps every test-control environment variable out of the production runtime", () => {
    const source = readFileSync(new URL("../src/service-supervisor-runtime.ts", import.meta.url), "utf8");
    expect(source).not.toContain("ALOOK_APP_TEST_");
  });
});
