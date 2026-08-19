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

  it("scrubs assignment, JSON, Basic auth, whitespace paths, and nested details", () => {
    const message = scrubDriverErrorMessage(
      'apiKey=supersecret {"apiKey":"jsonsecret"} Authorization: Basic abc123 at /Users/Alice Smith/private key.json',
    );
    for (const secret of ["supersecret", "jsonsecret", "abc123", "Alice Smith", "private key.json"]) {
      expect(message).not.toContain(secret);
    }

    const scrubbed = scrubDriverError({
      category: "sdk",
      code: "vendor said /Users/Alice/private",
      message: "failed",
      retryable: false,
      details: {
        apiKey: "detail-secret",
        nested: { authorization: "Basic nested-secret", path: "/Users/Alice Smith/private key.json" },
      },
    });
    expect(scrubbed.code).toBe("runtime_error");
    expect(JSON.stringify(scrubbed.details)).not.toMatch(/detail-secret|nested-secret|Alice Smith|private key/);
  });

  it("rejects vendor text as a public machine-readable code", () => {
    expect(stableErrorCode("ENOENT", "probe_failed")).toBe("ENOENT");
    expect(stableErrorCode("failed at /Users/alice secret", "probe_failed")).toBe("probe_failed");
  });
});
