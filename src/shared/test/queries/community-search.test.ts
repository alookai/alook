import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery } from "../../src/db/queries/community/search";

describe("sanitizeFtsQuery", () => {
  it("single word produces prefix match", () => {
    expect(sanitizeFtsQuery("hi")).toBe('"hi"*');
  });

  it("multiple words produce implicit AND with prefix on each", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello"* "world"*');
  });

  it("strips FTS special characters", () => {
    expect(sanitizeFtsQuery('"test-case"')).toBe('"test"* "case"*');
  });

  it("strips FTS keywords", () => {
    expect(sanitizeFtsQuery("not bad")).toBe('"bad"*');
    expect(sanitizeFtsQuery("cats AND dogs")).toBe('"cats"* "dogs"*');
  });

  it("returns empty phrase for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe('""');
    expect(sanitizeFtsQuery("   ")).toBe('""');
  });

  it("handles all-keyword input as empty", () => {
    expect(sanitizeFtsQuery("AND OR NOT")).toBe('""');
  });
});
