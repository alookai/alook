import { describe, it, expect } from "vitest";
import { mergeEnvLayers, type EnvLayer } from "./spawnEnv.js";

describe("mergeEnvLayers", () => {
  it("applies non-sensitive layers in ascending precedence (higher wins)", () => {
    const layers: EnvLayer[] = [
      { name: "low", precedence: 10, vars: { A: "low", B: "low" } },
      { name: "high", precedence: 30, vars: { A: "high" } },
      { name: "mid", precedence: 20, vars: { B: "mid" } },
    ];
    const env = mergeEnvLayers({}, layers);
    expect(env.A).toBe("high");
    expect(env.B).toBe("mid");
  });

  it("keeps base values unless a layer overrides them", () => {
    const env = mergeEnvLayers({ KEEP: "base", OVER: "base" }, [
      { name: "x", precedence: 10, vars: { OVER: "layer" } },
    ]);
    expect(env.KEEP).toBe("base");
    expect(env.OVER).toBe("layer");
  });

  it("skips undefined values so a layer can omit without clobbering", () => {
    const env = mergeEnvLayers({ X: "base" }, [{ name: "x", precedence: 10, vars: { X: undefined } }]);
    expect(env.X).toBe("base");
  });

  it("applies sensitive layers AFTER all non-sensitive, regardless of precedence", () => {
    // A non-sensitive layer with higher numeric precedence must NOT beat a
    // sensitive layer with lower numeric precedence.
    const layers: EnvLayer[] = [
      { name: "loud", precedence: 999, vars: { TOKEN: "spoofed" } },
      { name: "credential", precedence: 1, sensitive: true, vars: { TOKEN: "real" } },
    ];
    const env = mergeEnvLayers({}, layers);
    expect(env.TOKEN).toBe("real");
  });

});
