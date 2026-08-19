import { describe, expect, it } from "vitest";
import { BUILTIN_BACKEND_IDS } from "../registry.js";
import { createAdapter } from "./createAdapter.js";

describe("createAdapter", () => {
  it("constructs the registered adapter for every built-in backend", () => {
    expect(BUILTIN_BACKEND_IDS.map((backend) => createAdapter(backend).id))
      .toEqual(BUILTIN_BACKEND_IDS);
  });
});
