import { describe, expect, it } from "vitest";
import { resolveOpenCodeCompatibility } from "./compatibility.js";

describe("OpenCode CLI major compatibility", () => {
  it.each(["1.17.20", "1.18.35", "opencode v1.19.0", "v1.19.1-beta.2"])("preserves CLI v1 arguments for %s", (version) => {
    expect(resolveOpenCodeCompatibility(version)).toMatchObject({ major: 1, serviceArgs: ["serve", "--pure"], modelArgs: ["models", "--pure"] });
  });

  it.each(["2.0.28", "opencode v2.0.29", "v2.1.0"])("selects CLI v2 arguments for %s", (version) => {
    expect(resolveOpenCodeCompatibility(version)).toMatchObject({ major: 2, serviceArgs: ["serve"], modelArgs: ["models", "--standalone"] });
  });

  it.each([undefined, "", "unknown", "3.0.0", "error: version 2.0.28 failed"])("rejects unrecognized versions without defaulting: %s", (version) => {
    expect(() => resolveOpenCodeCompatibility(version)).toThrow("unrecognized or has an unsupported major");
  });
});
