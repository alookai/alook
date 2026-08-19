import { describe, expect, it } from "vitest";
import { parseStrictFailedSubset } from "../src/strict-failed-subset";

const options = {
  isTarget: (value: unknown): value is string => typeof value === "string" && value.length > 0,
  key: (value: string) => value,
};

describe("parseStrictFailedSubset", () => {
  it("accepts a unique non-empty requested subset", () => {
    expect(parseStrictFailedSubset(["u2"], ["u1", "u2"], options)).toEqual(["u2"]);
  });

  it.each([[], ["u2", "u2"], ["outside"], [1], null])("rejects %j", (value) => {
    expect(parseStrictFailedSubset(value, ["u1", "u2"], options)).toBeNull();
  });
});
