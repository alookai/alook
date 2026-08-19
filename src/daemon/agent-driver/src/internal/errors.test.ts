import { describe, expect, it } from "vitest";
import { scrubDriverError, scrubDriverErrorMessage, stableErrorCode } from "./errors.js";

describe("public driver error scrubbing", () => {
  it("removes credentials, email, query values, and filesystem paths", () => {
    const message = scrubDriverErrorMessage(
      "Bearer abc.def sk-proj-secret user@example.com https://api.invalid/x?token=secret at /Users/alice/private/file.json",
    );
    expect(message).not.toContain("abc.def");
    expect(message).not.toContain("sk-proj-secret");
    expect(message).not.toContain("user@example.com");
    expect(message).not.toContain("token=secret");
    expect(message).not.toContain("/Users/alice");
  });

  it("preserves the typed error classification while scrubbing its message", () => {
    expect(scrubDriverError({
      category: "internal",
      code: "prepare_failed",
      message: "failed under /Users/alice/private",
      retryable: false,
    })).toEqual({
      category: "internal",
      code: "prepare_failed",
      message: "failed under [redacted-path]",
      retryable: false,
    });
  });

  it("rejects vendor text as a public machine-readable code", () => {
    expect(stableErrorCode("ENOENT", "probe_failed")).toBe("ENOENT");
    expect(stableErrorCode("failed at /Users/alice secret", "probe_failed")).toBe("probe_failed");
  });
});
