import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isNewer,
  isNpx,
  detectPackageManager,
  installArgs,
  installCmdString,
  ensureInstalled,
  type PackageManager,
} from "./installer.js";

const ENV_KEYS = [
  "npm_command",
  "npm_execpath",
  "npm_config_user_agent",
  "ALOOK_SERVER_URL",
];
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function resetEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  resetEnv();
});

describe("isNewer", () => {
  it("compares major.minor.patch", () => {
    expect(isNewer("0.0.1", "0.0.2")).toBe(true);
    expect(isNewer("0.0.2", "0.0.1")).toBe(false);
    expect(isNewer("0.0.1", "0.0.1")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.0.9")).toBe(false);
    expect(isNewer("0.9.9", "1.0.0")).toBe(true);
  });

  it("strips prerelease suffixes before comparing", () => {
    expect(isNewer("0.0.1", "0.0.2-beta.1")).toBe(true);
    expect(isNewer("0.0.2-beta.1", "0.0.2")).toBe(false);
  });
});

describe("isNpx", () => {
  it("returns false when neither env var is set", () => {
    expect(isNpx()).toBe(false);
  });

  it("returns true when npm_command is 'exec'", () => {
    process.env.npm_command = "exec";
    expect(isNpx()).toBe(true);
  });

  it("returns true when npm_execpath points at npx-cli", () => {
    process.env.npm_execpath =
      "/usr/local/lib/node_modules/npm/bin/npx-cli.js";
    expect(isNpx()).toBe(true);
  });
});

describe("detectPackageManager", () => {
  it("defaults to npm", () => {
    expect(detectPackageManager()).toBe("npm");
  });

  it("detects pnpm from user agent", () => {
    process.env.npm_config_user_agent = "pnpm/8.0.0 npm/? node/v20";
    expect(detectPackageManager()).toBe("pnpm");
  });

  it("detects yarn from user agent", () => {
    process.env.npm_config_user_agent = "yarn/3.0.0 npm/? node/v20";
    expect(detectPackageManager()).toBe("yarn");
  });
});

describe("installArgs", () => {
  it("returns npm install args", () => {
    expect(installArgs("npm")).toEqual([
      "npm",
      ["install", "-g", "@alook/cli@latest"],
    ]);
  });
  it("returns pnpm add args", () => {
    expect(installArgs("pnpm")).toEqual(["pnpm", ["add", "-g", "@alook/cli"]]);
  });
  it("returns yarn global add args", () => {
    expect(installArgs("yarn")).toEqual([
      "yarn",
      ["global", "add", "@alook/cli"],
    ]);
  });
});

describe("installCmdString", () => {
  it("formats the command for display", () => {
    expect(installCmdString("npm")).toBe("npm install -g @alook/cli@latest");
    expect(installCmdString("pnpm")).toBe("pnpm add -g @alook/cli");
    expect(installCmdString("yarn")).toBe("yarn global add @alook/cli");
  });
});

describe("ensureInstalled", () => {
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
  };

  beforeEach(() => {
    logs.length = 0;
  });

  it("skips in dev mode", async () => {
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => true,
        fetchLatest: vi.fn(async () => "0.0.2"),
        runInstall: vi.fn(() => true),
        getCurrent: () => "0.0.1",
        isNpxFn: () => false,
        log,
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.action).toBe("none");
  });

  it("skips when opts.skip is true", async () => {
    const result = await ensureInstalled(
      { skip: true },
      {
        isDevFn: () => false,
        fetchLatest: vi.fn(async () => "0.0.2"),
        runInstall: vi.fn(() => true),
        getCurrent: () => "0.0.1",
        isNpxFn: () => false,
        log,
      },
    );
    expect(result.skipped).toBe(true);
  });

  it("returns action=none when registry fetch fails", async () => {
    const run = vi.fn(() => true);
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => false,
        fetchLatest: async () => null,
        runInstall: run,
        getCurrent: () => "0.0.1",
        isNpxFn: () => true,
        log,
      },
    );
    expect(result.action).toBe("none");
    expect(result.latest).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("installs when running via npx", async () => {
    const run = vi.fn((_: PackageManager) => true);
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => false,
        fetchLatest: async () => "0.0.2",
        runInstall: run,
        getCurrent: () => "0.0.1",
        isNpxFn: () => true,
        log,
      },
    );
    expect(result.action).toBe("installed");
    expect(run).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes("Installing"))).toBe(true);
  });

  it("updates when globally installed but outdated", async () => {
    const run = vi.fn(() => true);
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => false,
        fetchLatest: async () => "0.0.2",
        runInstall: run,
        getCurrent: () => "0.0.1",
        isNpxFn: () => false,
        log,
      },
    );
    expect(result.action).toBe("updated");
    expect(run).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes("Updating"))).toBe(true);
  });

  it("does nothing when globally installed and up to date", async () => {
    const run = vi.fn(() => true);
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => false,
        fetchLatest: async () => "0.0.2",
        runInstall: run,
        getCurrent: () => "0.0.2",
        isNpxFn: () => false,
        log,
      },
    );
    expect(result.action).toBe("none");
    expect(run).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("up to date"))).toBe(true);
  });

  it("reports failure when the install command exits non-zero", async () => {
    const run = vi.fn(() => false);
    const result = await ensureInstalled(
      {},
      {
        isDevFn: () => false,
        fetchLatest: async () => "0.0.2",
        runInstall: run,
        getCurrent: () => "0.0.1",
        isNpxFn: () => true,
        log,
      },
    );
    expect(result.action).toBe("failed");
    expect(logs.some((l) => l.includes("Could not install"))).toBe(true);
    expect(logs.some((l) => l.includes("Install it manually"))).toBe(true);
  });
});
