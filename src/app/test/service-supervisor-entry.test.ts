import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
