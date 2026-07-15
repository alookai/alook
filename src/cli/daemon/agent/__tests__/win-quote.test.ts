import { describe, it, expect } from "vitest";
import { quoteWinArg, quoteWinArgs } from "../win-quote.js";

describe("quoteWinArg", () => {
  it("leaves simple tokens untouched", () => {
    expect(quoteWinArg("simple")).toBe("simple");
    expect(quoteWinArg("--flag")).toBe("--flag");
    expect(quoteWinArg("value123")).toBe("value123");
  });

  it("wraps paths containing spaces", () => {
    expect(quoteWinArg("C:\\Users\\John Doe\\.alook")).toBe(
      "\"C:\\Users\\John Doe\\.alook\"",
    );
  });

  it("escapes embedded double quotes", () => {
    expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("doubles trailing backslashes before the closing quote when quoting", () => {
    // Only relevant when we DO quote — a bare `trailing\` needs no quoting so
    // MSVCRT parses it as-is. But `path with space\` must be quoted, and the
    // trailing backslash must be doubled so MSVCRT doesn't read the closing
    // quote as escaped.
    expect(quoteWinArg("path with\\")).toBe("\"path with\\\\\"");
    expect(quoteWinArg("has space\\\\")).toBe("\"has space\\\\\\\\\"");
    expect(quoteWinArg("trailing\\")).toBe("trailing\\");
  });

  it("preserves backslashes that don't precede a quote", () => {
    expect(quoteWinArg("a\\b c")).toBe("\"a\\b c\"");
  });

  it("doubles a backslash run that precedes an embedded quote", () => {
    // MSVCRT rule: N backslashes before a `"` become 2N+1 backslashes + `"`.
    // Two backslashes + `"` → four backslashes + escaped quote.
    expect(quoteWinArg('a\\\\"b c')).toBe('"a\\\\\\\\\\"b c"');
    // One backslash + `"` → two backslashes + escaped quote.
    expect(quoteWinArg('a\\"b c')).toBe('"a\\\\\\"b c"');
  });

  it("quotes args containing cmd metachars", () => {
    expect(quoteWinArg("a&b")).toBe("\"a&b\"");
    expect(quoteWinArg("a|b")).toBe("\"a|b\"");
    expect(quoteWinArg("a>b")).toBe("\"a>b\"");
    expect(quoteWinArg("100%")).toBe("\"100%\"");
  });

  it("quotes empty string", () => {
    expect(quoteWinArg("")).toBe("\"\"");
  });

  it("maps arrays through quoteWinArgs", () => {
    expect(
      quoteWinArgs([
        "run",
        "--dir",
        "C:\\Users\\John Doe\\.alook\\workspaces",
        "hello world",
      ]),
    ).toEqual([
      "run",
      "--dir",
      "\"C:\\Users\\John Doe\\.alook\\workspaces\"",
      "\"hello world\"",
    ]);
  });
});
