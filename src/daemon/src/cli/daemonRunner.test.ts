import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PreparedDaemon } from "./daemonRunner";
import { createDaemonProcessLogger, DAEMON_LOG_MAX_BYTES, logDaemonStartup, logDaemonUp } from "./daemonRunner";

describe("daemon runner logger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes one structured JSON record per physical line with secure modes", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logger.info("hostile\nmessage", { header: "spoof", agentId: "a1" });
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      header: "@alook/daemon",
      level: "info",
      message: "hostile\nmessage",
      fields: { header: "spoof", agentId: "a1" },
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps active and rotated generations within the hard cap", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    const payload = "x".repeat(256 * 1024);
    for (let i = 0; i < 80; i++) logger.info("chunk", { payload, i });
    for (const file of [logPath, `${logPath}.1`]) {
      if (!fs.existsSync(file)) continue;
      expect(fs.statSync(file).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("removes legacy oversized active and rotated generations before startup", () => {
    const logPath = path.join(dir, "daemon.log");
    fs.writeFileSync(logPath, "");
    fs.writeFileSync(`${logPath}.1`, "");
    fs.truncateSync(logPath, DAEMON_LOG_MAX_BYTES + 1);
    fs.truncateSync(`${logPath}.1`, DAEMON_LOG_MAX_BYTES + 1);

    createDaemonProcessLogger(dir, false);

    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.readFileSync(logPath, "utf8")).toContain("oversize daemon log generation removed");
  });

  it("drops an oversize event whole and records only one bounded warning", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    const payload = "x".repeat(DAEMON_LOG_MAX_BYTES);
    logger.info("oversize", { payload });
    logger.info("oversize", { payload });
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ message: "daemon log record dropped: oversize" })]);
  });

  it("records a safe startup and runtime probe summary", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logDaemonStartup(logger, {
      machineId: "machine-1",
      machineKey: "cmk_must_not_log",
      daemonVersion: "1.2.3",
      runtimeReport: [
        { id: "claude", status: "healthy", version: "4", lastError: "secret healthy detail" },
        { id: "codex", status: "unhealthy", lastError: "secret failure detail" },
      ],
    } as PreparedDaemon);

    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(record).toMatchObject({
      level: "info",
      message: "daemon startup",
      fields: {
        machineId: "machine-1",
        version: "1.2.3",
        healthyRuntimeIds: ["claude"],
        unhealthyRuntimeIds: ["codex"],
      },
    });
    expect(JSON.stringify(record)).not.toContain("cmk_must_not_log");
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("records only URL protocols when the daemon is up", () => {
    const { logger, logPath } = createDaemonProcessLogger(dir, false);
    logDaemonUp(
      logger,
      "http://user:password@127.0.0.1:1234/proxy?token=proxy-secret",
      "wss://control.example/ws?access_token=control-secret",
    );

    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(record).toMatchObject({
      message: "daemon up",
      fields: { proxyProtocol: "http", controlProtocol: "wss" },
    });
    expect(JSON.stringify(record)).not.toContain("password");
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("control.example");
  });
});
