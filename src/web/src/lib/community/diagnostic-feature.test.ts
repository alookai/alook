import { describe, expect, it } from "vitest";
import {
  isBugReportsEnabled,
  projectBugReportsFeature,
} from "./diagnostic-feature";

describe("diagnostic report feature flag", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    [true, false],
    ["true", true],
  ])("treats only the exact string true as enabled", (value, expected) => {
    expect(isBugReportsEnabled({ BUG_REPORTS_ENABLED: value } as never)).toBe(expected);
  });

  it("projects one boolean and never exposes the raw environment value", () => {
    const projected = projectBugReportsFeature({
      BUG_REPORTS_ENABLED: "true",
      BUG_REPORTS: { privateBinding: true },
      API_TOKEN: "secret",
    } as never);

    expect(projected).toEqual({ bugReports: true });
    expect(Object.keys(projected)).toEqual(["bugReports"]);
    expect(JSON.stringify(projected)).not.toMatch(/BUG_REPORTS|TOKEN|privateBinding|secret/);
  });
});
