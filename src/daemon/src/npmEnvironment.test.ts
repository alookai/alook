import { describe, expect, it } from "vitest";
import { withoutNpmExecPackage } from "./npmEnvironment.js";

describe("withoutNpmExecPackage", () => {
  it("removes inherited package selection case-insensitively without mutating its input", () => {
    const source = {
      npm_config_package: "@alook/daemon@latest",
      NPM_CONFIG_PACKAGE: "@alook/daemon@0.1.60",
      npm_config_registry: "https://registry.example.test",
      npm_config_cache: "/custom/cache",
      npm_config_proxy: "http://proxy.example.test",
      npm_config_userconfig: "/custom/npmrc",
      NODE_AUTH_TOKEN: "fixture-token",
      PATH: "/custom/bin",
      npm_config_yes: "true",
    };
    expect(withoutNpmExecPackage(source)).toEqual({
      npm_config_registry: source.npm_config_registry,
      npm_config_cache: source.npm_config_cache,
      npm_config_proxy: source.npm_config_proxy,
      npm_config_userconfig: source.npm_config_userconfig,
      NODE_AUTH_TOKEN: source.NODE_AUTH_TOKEN,
      PATH: source.PATH,
      npm_config_yes: source.npm_config_yes,
    });
    expect(source.npm_config_package).toBe("@alook/daemon@latest");
    expect(source.NPM_CONFIG_PACKAGE).toBe("@alook/daemon@0.1.60");
  });
});
