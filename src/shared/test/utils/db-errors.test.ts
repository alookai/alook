import { describe, it, expect } from "vitest";
import { isUniqueConstraintError } from "../../src/utils/db-errors";

describe("isUniqueConstraintError", () => {
  it("returns true for error with SQLITE_CONSTRAINT_UNIQUE code", () => {
    const err = Object.assign(new Error("constraint failed"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it("returns true for error with UNIQUE in message", () => {
    const err = new Error("UNIQUE constraint failed: table.column");
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it("returns true for DrizzleQueryError wrapping a UNIQUE error as cause", () => {
    const inner = Object.assign(new Error("constraint"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    const outer = Object.assign(new Error("Query failed"), { cause: inner });
    expect(isUniqueConstraintError(outer)).toBe(true);
  });

  it("returns true for nested cause chain", () => {
    const innermost = new Error("UNIQUE constraint failed");
    const middle = Object.assign(new Error("wrapped"), { cause: innermost });
    const outer = Object.assign(new Error("top level"), { cause: middle });
    expect(isUniqueConstraintError(outer)).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError("some string")).toBe(false);
    expect(isUniqueConstraintError(42)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isUniqueConstraintError(new Error("connection timeout"))).toBe(false);
    expect(isUniqueConstraintError(new Error("FOREIGN KEY constraint"))).toBe(false);
  });
});
