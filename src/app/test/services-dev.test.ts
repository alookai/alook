import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const previousRoot = process.env.ALOOK_PROJECT_ROOT;
  process.env.ALOOK_PROJECT_ROOT = "/workspace/alook";
  return { previousRoot };
});

vi.mock("@alook/shared", () => ({ resolveMode: vi.fn(() => "dev") }));
vi.mock("../src/lib/constants.js", async (loadOriginal) => ({
  ...await loadOriginal<typeof import("../src/lib/constants.js")>(),
  SELF_HOSTED_DIR: "/self-hosted",
}));
vi.mock("../src/lib/wrangler.js", () => ({ wranglerProcess: vi.fn() }));

import { DEFAULT_SERVICE_PROFILE } from "../src/lib/constants.js";
import { createServiceCommand } from "../src/lib/services.js";

afterAll(() => {
  if (fixture.previousRoot === undefined) delete process.env.ALOOK_PROJECT_ROOT;
  else process.env.ALOOK_PROJECT_ROOT = fixture.previousRoot;
});

describe("development service commands", () => {
  it("runs Next and Wrangler from their source workspaces with exact inspector ports", () => {
    const web = createServiceCommand("web", DEFAULT_SERVICE_PROFILE);
    expect(web).toMatchObject({
      command: "npx",
      args: ["next", "dev", "--port", String(DEFAULT_SERVICE_PROFILE.web.business)],
      cwd: "/workspace/alook/src/web",
      env: { NODE_ENV: "development" },
    });
    expect(web.env.NODE_OPTIONS).toContain(`--inspect=127.0.0.1:${DEFAULT_SERVICE_PROFILE.web.inspector}`);

    for (const name of ["emailWorker", "wsDo", "wakeWorker"] as const) {
      expect(createServiceCommand(name, DEFAULT_SERVICE_PROFILE)).toMatchObject({
        command: "npx",
        args: expect.arrayContaining([
          "wrangler",
          "dev",
          "--port",
          String(DEFAULT_SERVICE_PROFILE[name].business),
          "--inspector-port",
          String(DEFAULT_SERVICE_PROFILE[name].inspector),
        ]),
        cwd: `/workspace/alook/src/${name === "emailWorker" ? "email-worker" : name === "wsDo" ? "ws-do" : "wake-worker"}`,
      });
    }
  });
});
