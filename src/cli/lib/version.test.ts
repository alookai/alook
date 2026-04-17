import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getCurrentVersion } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("getCurrentVersion", () => {
  it("returns the version declared in the CLI's package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    );
    expect(getCurrentVersion()).toBe(pkg.version);
  });
});
