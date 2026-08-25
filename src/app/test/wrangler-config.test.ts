import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/alook-wrangler-config-${process.pid}`,
}));

vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: fixture.dir }));

import { patchWranglerConfigs } from "../src/lib/wrangler-config.js";

const profile = {
  web: { business: 25210, inspector: 29229 },
  emailWorker: { business: 25211, inspector: 29231 },
  wsDo: { business: 25212, inspector: 29230 },
  wakeWorker: { business: 25213, inspector: 29232 },
};

describe("patchWranglerConfigs", () => {
  beforeEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
    for (const directory of ["web", "email-worker", "ws-do", "wake-worker"]) {
      mkdirSync(join(fixture.dir, directory), { recursive: true });
      writeFileSync(join(fixture.dir, directory, "wrangler.toml"), [
        `name = "${directory}"`,
        "[dev]",
        "inspector_port = 9998",
        "port = 9999",
        "inspector_port = 9997",
      ].join("\n"));
    }
  });

  afterEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("writes the exact name-keyed business and inspector profile to all four configs", () => {
    patchWranglerConfigs(profile);
    const expectations = {
      web: profile.web,
      "email-worker": profile.emailWorker,
      "ws-do": profile.wsDo,
      "wake-worker": profile.wakeWorker,
    };
    for (const [directory, ports] of Object.entries(expectations)) {
      const content = readFileSync(join(fixture.dir, directory, "wrangler.toml"), "utf8");
      expect(content.match(/^port\s*=/gm)).toHaveLength(1);
      expect(content.match(/^inspector_port\s*=/gm)).toHaveLength(1);
      expect(content).toContain(`port = ${ports.business}`);
      expect(content).toContain(`inspector_port = ${ports.inspector}`);
    }
  });

  it("patches Web service URLs from the same business profile", () => {
    patchWranglerConfigs(profile);
    const content = readFileSync(join(fixture.dir, "web", "wrangler.toml"), "utf8");
    expect(content).toContain('DEV_WS_DO_URL = "http://localhost:25212"');
    expect(content).toContain('DEV_EMAIL_WORKER_URL = "http://localhost:25211"');
    expect(content).toContain('DEV_WAKE_WORKER_URL = "http://localhost:25213"');
  });
});
