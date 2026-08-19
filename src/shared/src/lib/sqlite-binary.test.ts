import { describe, expect, it } from "vitest";
import { compareAsciiSqliteBinary } from "./sqlite-binary";

describe("compareAsciiSqliteBinary", () => {
  it("matches SQLite BINARY descending order for mixed-case nanoids", () => {
    const ids = [
      "3kY1MAppCm6RYM4IvnXPN",
      "XzKeKetmiRMJ16hwOrhSl",
      "bc02tEwQaazjdPwrMuNih",
      "kMRip4KDm4Ki2HU8vQ2qd",
    ];

    expect(ids.sort((left, right) => compareAsciiSqliteBinary(right, left))).toEqual([
      "kMRip4KDm4Ki2HU8vQ2qd",
      "bc02tEwQaazjdPwrMuNih",
      "XzKeKetmiRMJ16hwOrhSl",
      "3kY1MAppCm6RYM4IvnXPN",
    ]);
  });
});
