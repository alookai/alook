import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-secrets-${process.pid}`);

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: testDir,
  PID_FILE: join(testDir, ".pids.json"),
  DEFAULT_PORTS: { web: 3000, emailWorker: 8787, wsDo: 8789 },
  WEB_URL: (port: number) => `http://localhost:${port}`,
}));

describe("secrets", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, "web"), { recursive: true });
    mkdirSync(join(testDir, "email-worker"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it("generates new secrets when none exist", async () => {
    const { ensureSecrets } = await import("../src/lib/secrets.js");
    ensureSecrets(3000);

    const webVars = join(testDir, "web", ".dev.vars");
    const emailVars = join(testDir, "email-worker", ".dev.vars");

    expect(existsSync(webVars)).toBe(true);
    expect(existsSync(emailVars)).toBe(true);

    const { readFileSync } = require("fs");
    const webContent = readFileSync(webVars, "utf-8");
    expect(webContent).toContain("BETTER_AUTH_SECRET=");
    expect(webContent).toContain("ENCRYPTION_KEY=");
    expect(webContent).toContain("BETTER_AUTH_URL=http://localhost:3000");
  });

  it("syncs encryption key from web to email-worker when email vars missing", async () => {
    // Pre-create web vars with a known key
    writeFileSync(
      join(testDir, "web", ".dev.vars"),
      "BETTER_AUTH_SECRET=abc\nENCRYPTION_KEY=test-key-123\n",
      { mode: 0o600 },
    );

    const { ensureSecrets } = await import("../src/lib/secrets.js");
    ensureSecrets(3000);

    const { readFileSync } = require("fs");
    const emailContent = readFileSync(join(testDir, "email-worker", ".dev.vars"), "utf-8");
    expect(emailContent).toContain("ENCRYPTION_KEY=test-key-123");
  });

  it("skips when both secret files already exist", async () => {
    writeFileSync(join(testDir, "web", ".dev.vars"), "existing", { mode: 0o600 });
    writeFileSync(join(testDir, "email-worker", ".dev.vars"), "existing", { mode: 0o600 });

    const consoleSpy = vi.spyOn(console, "log");
    const { ensureSecrets } = await import("../src/lib/secrets.js");
    ensureSecrets(3000);

    expect(consoleSpy).toHaveBeenCalledWith("Secrets already exist, skipping");
    consoleSpy.mockRestore();
  });
});
