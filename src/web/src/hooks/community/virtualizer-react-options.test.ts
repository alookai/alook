import { describe, expect, it } from "vitest"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "./virtualizer-react-options"

describe("COMMUNITY_VIRTUALIZER_REACT_OPTIONS", () => {
  it("uses native synchronous range updates with direct DOM geometry", () => {
    expect(COMMUNITY_VIRTUALIZER_REACT_OPTIONS).toEqual({
      useFlushSync: true,
      directDomUpdates: true,
    })
  })
})
