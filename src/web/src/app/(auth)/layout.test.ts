import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("(auth) layout metadata", () => {
  it("gives sign-in its own noindex metadata", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toEqual({ canonical: "/sign-in" });
  });
});
