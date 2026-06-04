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
});

describe("configDir — three ALOOK_PROJECT_ROOT scenarios", () => {
  it("production: returns ~/.alook (ALOOK_PROJECT_ROOT unset)", () => {
    delete process.env.ALOOK_PROJECT_ROOT;
    expect(configDir()).toBe(join(homedir(), ".alook"));
  });

  it("dev mode: returns ALOOK_PROJECT_ROOT directly", () => {
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project/.alook";
    expect(configDir()).toBe("/tmp/my-project/.alook");
  });

  it("app mode: returns ALOOK_PROJECT_ROOT when set to self-hosted dir", () => {
    process.env.ALOOK_PROJECT_ROOT = join(homedir(), ".alook", "self-hosted");
    expect(configDir()).toBe(join(homedir(), ".alook", "self-hosted"));
  });
});

describe("configPath", () => {
  it("returns ~/.alook/config.json by default", () => {
    expect(configPath()).toBe(join(homedir(), ".alook", "config.json"));
  });

  it("returns <ALOOK_PROJECT_ROOT>/config.json when set", () => {
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project/.alook";
    expect(configPath()).toBe(join("/tmp/my-project/.alook", "config.json"));
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
      watched_workspaces: [{ id: "w2", name: "Root WS", token: "ws-token", status: "active" }],
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

  it("migrates legacy machine_token into watched_workspaces as registered item", () => {
    const cfg = {
      server_url: "http://example.com",
      watched_workspaces: [{ id: "w1", name: "WS1", token: "t1" }],
      machine_token: "al_legacy_token",
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    const result = loadCLIConfigForProfile();
    expect(result.watched_workspaces).toHaveLength(2);
    expect(result.watched_workspaces[0]).toMatchObject({ id: "w1", status: "active" });
    expect(result.watched_workspaces[1]).toMatchObject({
      id: null,
      name: null,
      token: "al_legacy_token",
      status: "registered",
      agent_ids: [],
    });
  });

  it("does not duplicate if machine_token already in watched_workspaces", () => {
    const cfg = {
      server_url: "http://example.com",
      watched_workspaces: [{ id: null, name: null, token: "al_same", status: "registered" }],
      machine_token: "al_same",
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    const result = loadCLIConfigForProfile();
    expect(result.watched_workspaces).toHaveLength(1);
    expect(result.watched_workspaces[0].token).toBe("al_same");
  });

  it("defaults status to active for old entries with an id", () => {
    const cfg = {
      server_url: "http://example.com",
      watched_workspaces: [{ id: "w1", name: "WS1", token: "t1" }],
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    const result = loadCLIConfigForProfile();
    expect(result.watched_workspaces[0].status).toBe("active");
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

  it("writes to ALOOK_PROJECT_ROOT when set", () => {
    process.env.ALOOK_PROJECT_ROOT = "/tmp/my-project/.alook";

    const cfg = { server_url: "http://localhost:3000", watched_workspaces: [] };
    saveCLIConfig(cfg);

    expect(mockedMkdirSync).toHaveBeenCalledWith(
      "/tmp/my-project/.alook",
      { recursive: true, mode: 0o700 },
    );
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join("/tmp/my-project/.alook", "config.json"),
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

  it("preserves multiple watched_workspaces when saving", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({}));

    const profileCfg = {
      server_url: "http://example.com",
      watched_workspaces: [
        { id: "w1", name: "First", token: "t1", status: "active" as const },
        { id: "w2", name: "Second", token: "t2", status: "active" as const },
        { id: null, name: null, token: "t3", status: "registered" as const },
      ],
    };
    saveCLIConfigForProfile(undefined, profileCfg);

    const written = JSON.parse(
      mockedWriteFileSync.mock.calls[0][1] as string,
    );
    expect(written.watched_workspaces).toHaveLength(3);
    expect(written.watched_workspaces[0].id).toBe("w1");
    expect(written.watched_workspaces[2].status).toBe("registered");
  });

  it("removes legacy machine_token from config on save", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ machine_token: "al_old", server_url: "" }));

    saveCLIConfigForProfile(undefined, {
      server_url: "http://example.com",
      watched_workspaces: [{ id: null, name: null, token: "al_old", status: "registered" }],
    });

    const written = JSON.parse(
      mockedWriteFileSync.mock.calls[0][1] as string,
    );
    expect(written.machine_token).toBeUndefined();
  });
});

describe("loadCLIConfigForProfile — multiple workspaces", () => {
  it("returns all watched_workspaces from root config", () => {
    const cfg = {
      server_url: "http://example.com",
      watched_workspaces: [
        { id: "w1", name: "WS1", token: "t1" },
        { id: "w2", name: "WS2", token: "t2" },
      ],
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    const result = loadCLIConfigForProfile();
    expect(result.watched_workspaces).toHaveLength(2);
    expect(result.watched_workspaces[0].id).toBe("w1");
    expect(result.watched_workspaces[1].id).toBe("w2");
  });

  it("returns all watched_workspaces from profile config", () => {
    const cfg = {
      profiles: {
        prod: {
          server_url: "https://prod.example.com",
          watched_workspaces: [
            { id: "wp1", name: "Prod WS 1", token: "tp1" },
            { id: "wp2", name: "Prod WS 2", token: "tp2" },
            { id: "wp3", name: "Prod WS 3", token: "tp3" },
          ],
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(cfg));

    const result = loadCLIConfigForProfile("prod");
    expect(result.watched_workspaces).toHaveLength(3);
    expect(result.watched_workspaces.map((w: any) => w.id)).toEqual(["wp1", "wp2", "wp3"]);
  });
});
