import { describe, it, expect } from "vitest";
import { getRootOpts } from "./command-utils.js";

describe("getRootOpts", () => {
  it("returns opts from root command (no parent)", () => {
    const cmd = { parent: null, opts: () => ({ server: "https://x.com", profile: "dev" }) } as any;
    expect(getRootOpts(cmd)).toEqual({ server: "https://x.com", profile: "dev" });
  });

  it("traverses up to root from deeply nested command", () => {
    const root = { parent: null, opts: () => ({ server: "https://root.com" }) } as any;
    const mid = { parent: root, opts: () => ({ mid: true }) } as any;
    const leaf = { parent: mid, opts: () => ({ leaf: true }) } as any;

    expect(getRootOpts(leaf)).toEqual({ server: "https://root.com" });
  });

  it("returns empty object if root has no opts", () => {
    const root = { parent: null, opts: () => ({}) } as any;
    const child = { parent: root, opts: () => ({ something: true }) } as any;

    expect(getRootOpts(child)).toEqual({});
  });
});
