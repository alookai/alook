import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyOpenCodeApiEnvironment } from "./legacy-auth.js";

describe("legacy OpenCode API credentials", () => {
  let directory: string;
  let environment: Record<string, string>;
  let authFile: string;
  let catalogFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "opencode-api-compat-"));
    environment = { XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache") };
    authFile = path.join(environment.XDG_DATA_HOME!, "opencode", "auth.json");
    catalogFile = path.join(environment.XDG_CACHE_HOME!, "opencode", "models.json");
    await mkdir(path.dirname(authFile), { recursive: true });
    await mkdir(path.dirname(catalogFile), { recursive: true });
    await writeFile(authFile, JSON.stringify({
      deepseek: { type: "api", key: "saved-key" }, other: { type: "api", key: "private-other-key" },
    }));
    await writeFile(catalogFile, JSON.stringify({ deepseek: { env: ["DEEPSEEK_API_KEY"] } }));
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const resolve = (environment: Record<string, string>, model = "deepseek/deepseek-flash") =>
    legacyOpenCodeApiEnvironment(environment, model);

  it("exports only the selected provider's API key without changing input or auth", async () => {
    const original = await readFile(authFile, "utf8");
    expect(await resolve(environment)).toEqual({ DEEPSEEK_API_KEY: "saved-key" });
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
    expect(await readFile(authFile, "utf8")).toBe(original);
  });

  it.each(["explicit-key", ""])("preserves an explicit credential, including an empty value (%s)", async (key) => {
    expect(await resolve({ ...environment, DEEPSEEK_API_KEY: key })).toEqual({});
  });

  it("preserves an alternative native credential", async () => {
    await writeFile(catalogFile, JSON.stringify({ deepseek: { env: ["DEEPSEEK_API_KEY", "DEEPSEEK_TOKEN"] } }));
    expect(await resolve({ ...environment, DEEPSEEK_TOKEN: "explicit-token" })).toEqual({});
  });

  it("uses valid inline auth before the file and falls back for malformed inline auth", async () => {
    expect(await resolve({ ...environment, OPENCODE_AUTH_CONTENT: JSON.stringify({ deepseek: { type: "api", key: "inline-key" } }) }))
      .toEqual({ DEEPSEEK_API_KEY: "inline-key" });
    expect(await resolve({ ...environment, OPENCODE_AUTH_CONTENT: "{" })).toEqual({ DEEPSEEK_API_KEY: "saved-key" });
    expect(await resolve({ ...environment, OPENCODE_AUTH_CONTENT: "{}" })).toEqual({});
  });

  it.each([
    { type: "oauth", access: "private-access", refresh: "private-refresh" },
    { type: "api", key: " " }, { type: "api", key: 123 }, { type: "wellknown", key: "other" }, null,
  ])("does not convert unsupported auth: %j", async (credential) => {
    await writeFile(authFile, JSON.stringify({ deepseek: credential }));
    expect(await resolve(environment)).toEqual({});
  });

  it.each(["unknown/model", "deepseek", "/model", ""])("does not invent a provider mapping for %s", async (model) => {
    expect(await resolve(environment, model)).toEqual({});
  });

  it("leaves default models unchanged", async () => {
    expect(await legacyOpenCodeApiEnvironment(environment, undefined)).toEqual({});
  });

  it.each(["auth", "catalog"])("tolerates missing, malformed and oversized %s files", async (kind) => {
    const file = kind === "auth" ? authFile : catalogFile;
    await rm(file);
    expect(await resolve(environment)).toEqual({});
    await writeFile(file, "{");
    expect(await resolve(environment)).toEqual({});
    await writeFile(file, " ".repeat((kind === "auth" ? 1 : 16) * 1024 * 1024 + 1));
    expect(await resolve(environment)).toEqual({});
  });

  it("does not put secrets in non-credential environment variables", async () => {
    await writeFile(catalogFile, JSON.stringify({ deepseek: { env: ["PATH", "LD_PRELOAD", "AWS_ACCESS_KEY_ID", 42] } }));
    expect(await resolve(environment)).toEqual({});
  });

  it("honors an explicit catalog and does not use the default catalog for a custom source", async () => {
    const custom = path.join(directory, "custom.json");
    await writeFile(custom, JSON.stringify({ deepseek: { env: ["CUSTOM_TOKEN"] } }));
    expect(await resolve({ ...environment, OPENCODE_MODELS_PATH: custom })).toEqual({ CUSTOM_TOKEN: "saved-key" });
    expect(await resolve({ ...environment, OPENCODE_MODELS_URL: "https://catalog.example.invalid" })).toEqual({});
  });

  it("resolves standard paths from HOME when XDG paths are relative", async () => {
    await mkdir(path.join(directory, ".local", "share", "opencode"), { recursive: true });
    await mkdir(path.join(directory, ".cache", "opencode"), { recursive: true });
    await writeFile(path.join(directory, ".local", "share", "opencode", "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "home-key" } }));
    await writeFile(path.join(directory, ".cache", "opencode", "models.json"), JSON.stringify({ deepseek: { env: ["DEEPSEEK_API_KEY"] } }));
    expect(await resolve({ HOME: directory, USERPROFILE: directory, XDG_DATA_HOME: "relative", XDG_CACHE_HOME: "relative" }))
      .toEqual({ DEEPSEEK_API_KEY: "home-key" });
  });
});
