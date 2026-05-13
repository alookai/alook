import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import {
  configDir,
  configPath,
  loadCLIConfig,
  loadCLIConfigForProfile,
  saveCLIConfig,
  saveCLIConfigForProfile,
} from "./config.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ALOOK_SERVER_URL;
  delete process.env.ALOOK_PROJECT_ROOT;
  delete process.env.ALOOK_CONFIG_DIR;
  delete process.env.ALOOK_ROOT;
});

describe("configDir", () => {
  it("returns ~/.alook in production", () => {
    expect(configDir()).toBe(join(homedir(), ".alook"));
  });

  it("returns <project-root>/.alook in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";
    expect(configDir()).toBe(join("/tmp/my-project", ".alook"));
  });

  it("falls back to ~/.alook in dev mode without ALOOK_PROJECT_ROOT", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    expect(configDir()).toBe(join(homedir(), ".alook"));
  });

  it("uses ALOOK_ROOT as base data directory", () => {
    process.env.ALOOK_ROOT = "/tmp/custom-root";
    expect(configDir()).toBe("/tmp/custom-root");
  });

  it("uses ALOOK_CONFIG_DIR as full override", () => {
    process.env.ALOOK_CONFIG_DIR = "/tmp/custom-config";
    expect(configDir()).toBe("/tmp/custom-config");
  });

  it("ALOOK_CONFIG_DIR takes priority over ALOOK_ROOT", () => {
    process.env.ALOOK_ROOT = "/tmp/root";
    process.env.ALOOK_CONFIG_DIR = "/tmp/override";
    expect(configDir()).toBe("/tmp/override");
  });

  it("ALOOK_ROOT takes priority over ALOOK_PROJECT_ROOT", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";
    process.env.ALOOK_ROOT = "/tmp/custom-root";
    expect(configDir()).toBe("/tmp/custom-root");
  });
});

describe("configPath", () => {
  it("returns ~/.alook/config.json in production", () => {
    expect(configPath()).toBe(join(homedir(), ".alook", "config.json"));
  });

  it("returns <project-root>/.alook/config.json in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";
    expect(configPath()).toBe(join("/tmp/my-project", ".alook", "config.json"));
  });
});

describe("loadCLIConfig", () => {
  it("returns empty object when file doesn't exist", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadCLIConfig()).toEqual({});
  });

  it("returns parsed JSON when file exists", () => {
    const cfg = { server_url: "http://example.com", watched_workspaces: [] };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));
    expect(loadCLIConfig()).toEqual(cfg);
  });
});

describe("loadCLIConfigForProfile", () => {
  it("returns profile config when profile specified", () => {
    const profileCfg = {
      server_url: "http://profile.example.com",
      watched_workspaces: [{ id: "w1", name: "Workspace 1", token: "ws-token" }],
    };
    const cfg = { profiles: { staging: profileCfg } };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    expect(loadCLIConfigForProfile("staging")).toEqual(profileCfg);
  });

  it("uses default_profile when no profile specified", () => {
    const profileCfg = {
      server_url: "http://default.example.com",
      watched_workspaces: [],
    };
    const cfg = { default_profile: "prod", profiles: { prod: profileCfg } };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    expect(loadCLIConfigForProfile()).toEqual(profileCfg);
  });

  it("falls back to root-level fields when profile not found", () => {
    const cfg = {
      server_url: "http://root.example.com",
      watched_workspaces: [{ id: "w2", name: "Root WS", token: "ws-token" }],
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    expect(loadCLIConfigForProfile()).toEqual({
      server_url: "http://root.example.com",
      watched_workspaces: [{ id: "w2", name: "Root WS", token: "ws-token" }],
    });
  });

  it("returns empty defaults when no config exists", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(loadCLIConfigForProfile()).toEqual({
      server_url: "",
      watched_workspaces: [],
    });
  });
});

describe("saveCLIConfig", () => {
  it("writes valid JSON with mode 0600 to ~/.alook in production", () => {
    const cfg = { server_url: "http://example.com", watched_workspaces: [] };
    saveCLIConfig(cfg);

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      join(homedir(), ".alook"),
      { recursive: true, mode: 0o700 },
    );
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(homedir(), ".alook", "config.json"),
      JSON.stringify(cfg, null, 2),
      { mode: 0o600 },
    );
  });

  it("writes to <project-root>/.alook in dev mode", () => {
    process.env.ALOOK_SERVER_URL = "http://localhost:3000";
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project";

    const cfg = { server_url: "http://localhost:3000", watched_workspaces: [] };
    saveCLIConfig(cfg);

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      join("/tmp/my-project", ".alook"),
      { recursive: true, mode: 0o700 },
    );
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join("/tmp/my-project", ".alook", "config.json"),
      JSON.stringify(cfg, null, 2),
      { mode: 0o600 },
    );
  });
});

describe("saveCLIConfigForProfile", () => {
  it("updates specific profile", () => {
    const existing = { profiles: {} };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existing));

    const profileCfg = {
      server_url: "http://new.example.com",
      watched_workspaces: [],
    };
    saveCLIConfigForProfile("staging", profileCfg);

    const written = JSON.parse(
      mockedWriteFileSync.mock.calls[0][1] as string,
    );
    expect(written.profiles.staging).toEqual(profileCfg);
  });

  it("updates root-level fields when no profile specified", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({}));

    const profileCfg = {
      server_url: "http://root.example.com",
      watched_workspaces: [{ id: "w1", name: "WS", token: "ws-token" }],
    };
    saveCLIConfigForProfile(undefined, profileCfg);

    const written = JSON.parse(
      mockedWriteFileSync.mock.calls[0][1] as string,
    );
    expect(written.server_url).toBe("http://root.example.com");
    expect(written.watched_workspaces).toEqual([{ id: "w1", name: "WS", token: "ws-token" }]);
  });
});
