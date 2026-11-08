import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readDaemonVersion } from "./version";

describe("daemon release identity", () => {
  it("reports the installed package version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(readDaemonVersion()).toBe(manifest.version);
  });
});
