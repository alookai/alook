import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("(auth) layout metadata", () => {
  it("noindexes sign-in and other auth pages", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
