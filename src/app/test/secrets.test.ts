import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-secrets-${process.pid}`);

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: testDir,
  PID_FILE: join(testDir, ".pids.json"),
  DEFAULT_PORTS: { web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 },
  WEB_URL: (port: number) => `http://localhost:${port}`,
}));

describe("secrets", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, "web"), { recursive: true });
    mkdirSync(join(testDir, "email-worker"), { recursive: true });
    mkdirSync(join(testDir, "queue-worker"), { recursive: true });
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
    const queueVars = join(testDir, "queue-worker", ".dev.vars");

    expect(existsSync(webVars)).toBe(true);
    expect(existsSync(emailVars)).toBe(true);
    expect(existsSync(queueVars)).toBe(true);

    const { readFileSync } = require("fs");
    const webContent = readFileSync(webVars, "utf-8");
    expect(webContent).toContain("BETTER_AUTH_SECRET=");
    expect(webContent).toContain("ENCRYPTION_KEY=");
    expect(webContent).toContain("BETTER_AUTH_URL=http://localhost:3000");
    const encryptionKey = webContent.match(/^ENCRYPTION_KEY=(.+)$/m)?.[1];
    expect(encryptionKey).toBeTruthy();
    expect(readFileSync(emailVars, "utf-8")).toContain(`ENCRYPTION_KEY=${encryptionKey}`);
    const queueContent = readFileSync(queueVars, "utf-8");
    expect(queueContent).toContain(`ENCRYPTION_KEY=${encryptionKey}`);
    expect(queueContent).toContain("APNS_TEAM_ID=");
    expect(queueContent).toContain("FCM_PRIVATE_KEY=");
  });

  it("syncs the web encryption key to both workers", async () => {
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
    const queueContent = readFileSync(join(testDir, "queue-worker", ".dev.vars"), "utf-8");
    expect(emailContent).toContain("ENCRYPTION_KEY=test-key-123");
    expect(queueContent).toContain("ENCRYPTION_KEY=test-key-123");
  });

  it("adds a generated encryption key when existing web vars omit it", async () => {
    writeFileSync(
      join(testDir, "web", ".dev.vars"),
      "BETTER_AUTH_SECRET=abc\nBETTER_AUTH_URL=http://localhost:3000\n",
      { mode: 0o600 },
    );

    const { ensureSecrets } = await import("../src/lib/secrets.js");
    ensureSecrets(3000);

    const { readFileSync } = require("fs");
    const webContent = readFileSync(join(testDir, "web", ".dev.vars"), "utf-8");
    const encryptionKey = webContent.match(/^ENCRYPTION_KEY=(.+)$/m)?.[1];
    expect(encryptionKey).toBeTruthy();
    expect(readFileSync(join(testDir, "email-worker", ".dev.vars"), "utf-8"))
      .toContain(`ENCRYPTION_KEY=${encryptionKey}`);
    expect(readFileSync(join(testDir, "queue-worker", ".dev.vars"), "utf-8"))
      .toContain(`ENCRYPTION_KEY=${encryptionKey}`);
  });

  it("repairs drift while preserving provider credentials", async () => {
    writeFileSync(join(testDir, "web", ".dev.vars"), "ENCRYPTION_KEY=canonical\n", { mode: 0o600 });
    writeFileSync(join(testDir, "email-worker", ".dev.vars"), "ENCRYPTION_KEY=stale\n", { mode: 0o600 });
    writeFileSync(
      join(testDir, "queue-worker", ".dev.vars"),
      "ENCRYPTION_KEY=stale\nAPNS_TEAM_ID=team\n",
      { mode: 0o600 },
    );
    const { ensureSecrets } = await import("../src/lib/secrets.js");
    ensureSecrets(3000);

    const { readFileSync } = require("fs");
    expect(readFileSync(join(testDir, "email-worker", ".dev.vars"), "utf-8"))
      .toContain("ENCRYPTION_KEY=canonical");
    const queueContent = readFileSync(join(testDir, "queue-worker", ".dev.vars"), "utf-8");
    expect(queueContent).toContain("ENCRYPTION_KEY=canonical");
    expect(queueContent).toContain("APNS_TEAM_ID=team");
    expect(queueContent).toContain("FCM_PRIVATE_KEY=");
  });
});
