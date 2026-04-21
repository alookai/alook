import { vi, describe, it, expect, afterEach } from "vitest";
import { hostname } from "os";
import { join } from "path";
import { homedir } from "os";
import { loadDaemonConfig, normalizeServerBaseURL, daemonLogFilePath, daemonLogDir, sessionRunnerLogDir } from "./config.js";

const DAEMON_ENV_KEYS = [
  "ALOOK_SERVER_URL",
  "ALOOK_PROJECT_ROOT",
  "ALOOK_DAEMON_POLL_INTERVAL",
  "ALOOK_AGENT_TIMEOUT",
  "ALOOK_DAEMON_MAX_CONCURRENT_TASKS",
  "ALOOK_CLAUDE_PATH",
  "ALOOK_AGENT_RUNTIME_NAME",
  "ALOOK_DAEMON_ID",
  "ALOOK_WORKSPACES_ROOT",
  "ALOOK_DAEMON_DEVICE_NAME",
  "ALOOK_KEEP_ENV_AFTER_TASK",
  "ALOOK_CODEX_PATH",
  "ALOOK_OPENCODE_PATH",
  "ALOOK_CLAUDE_MODEL",
  "ALOOK_CODEX_MODEL",
  "ALOOK_OPENCODE_MODEL",
];

afterEach(() => {
  for (const key of DAEMON_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("loadDaemonConfig defaults", () => {
  it("returns correct defaults when no env vars set", () => {
    const cfg = loadDaemonConfig();

    expect(cfg.serverURL).toBe("https://alook.ai");
    expect(cfg.pollInterval).toBe(3000);
    expect(cfg.agentTimeout).toBe(43200000);
    expect(cfg.maxConcurrentTasks).toBe(20);
    expect(cfg.claudePath).toBe("claude");
    expect(cfg.runtimeName).toBe("Local Agent");
  });
});

describe("loadDaemonConfig env overrides", () => {
  it("ALOOK_SERVER_URL overrides serverURL", () => {
    process.env.ALOOK_SERVER_URL = "http://remote:9090";
    expect(loadDaemonConfig().serverURL).toBe("http://remote:9090");
  });

  it("ALOOK_DAEMON_POLL_INTERVAL='5s' → 5000", () => {
    process.env.ALOOK_DAEMON_POLL_INTERVAL = "5s";
    expect(loadDaemonConfig().pollInterval).toBe(5000);
  });

  it("ALOOK_DAEMON_MAX_CONCURRENT_TASKS='10' → 10", () => {
    process.env.ALOOK_DAEMON_MAX_CONCURRENT_TASKS = "10";
    expect(loadDaemonConfig().maxConcurrentTasks).toBe(10);
  });
});

describe("normalizeServerBaseURL", () => {
  it("converts ws:// to http://", () => {
    expect(normalizeServerBaseURL("ws://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  it("converts wss:// to https://", () => {
    expect(normalizeServerBaseURL("wss://example.com")).toBe(
      "https://example.com",
    );
  });

  it("strips /ws suffix", () => {
    expect(normalizeServerBaseURL("http://example.com/ws")).toBe(
      "http://example.com",
    );
  });

  it("leaves http:// unchanged", () => {
    expect(normalizeServerBaseURL("http://example.com")).toBe(
      "http://example.com",
    );
  });
});

describe("daemonId profile suffix", () => {
  it("uses hostname when no profile", () => {
    const cfg = loadDaemonConfig();
    expect(cfg.daemonId).toBe(hostname());
  });

  it("appends -profile to hostname with profile", () => {
    const cfg = loadDaemonConfig("staging");
    expect(cfg.daemonId).toBe(`${hostname()}-staging`);
  });

  it("doesn't double-append when ALOOK_DAEMON_ID already has suffix", () => {
    process.env.ALOOK_DAEMON_ID = `myhost-staging`;
    const cfg = loadDaemonConfig("staging");
    expect(cfg.daemonId).toBe("myhost-staging");
  });
});

describe("daemonLogFilePath", () => {
  it("returns <configDir>/daemon/logs/YYYY-MM-DD.log for a fixed date", () => {
    const d = new Date(2026, 3, 17); // 2026-04-17 local
    const p = daemonLogFilePath(d);
    expect(p).toBe(join(homedir(), ".alook", "daemon", "logs", "2026-04-17.log"));
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5); // 2026-01-05 local
    expect(daemonLogFilePath(d).endsWith("2026-01-05.log")).toBe(true);
  });

  it("honours ALOOK_PROJECT_ROOT in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/proj";
    expect(daemonLogDir()).toBe(join("/tmp/proj", ".alook", "daemon", "logs"));
  });
});

describe("workspacesRoot profile handling", () => {
  it("defaults to ~/.alook/workspaces without profile in production", () => {
    const cfg = loadDaemonConfig();
    expect(cfg.workspacesRoot).toBe(join(homedir(), ".alook", "workspaces"));
  });

  it("uses ~/.alook/workspaces_{profile} with profile in production", () => {
    const cfg = loadDaemonConfig("dev");
    expect(cfg.workspacesRoot).toBe(
      join(homedir(), ".alook", "workspaces_dev"),
    );
  });

  it("defaults to <project-root>/.alook/workspaces in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";
    const cfg = loadDaemonConfig();
    expect(cfg.workspacesRoot).toBe(
      join("/tmp/my-project", ".alook", "workspaces"),
    );
  });

  it("ALOOK_WORKSPACES_ROOT overrides dev mode default", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";
    process.env.ALOOK_WORKSPACES_ROOT = "/custom/path";
    const cfg = loadDaemonConfig();
    expect(cfg.workspacesRoot).toBe("/custom/path");
  });
});

describe("sessionRunnerLogDir", () => {
  it("returns <configDir>/daemon/session-runners", () => {
    expect(sessionRunnerLogDir()).toBe(
      join(homedir(), ".alook", "daemon", "session-runners"),
    );
  });

  it("honours ALOOK_PROJECT_ROOT in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/proj";
    expect(sessionRunnerLogDir()).toBe(
      join("/tmp/proj", ".alook", "daemon", "session-runners"),
    );
  });
});
