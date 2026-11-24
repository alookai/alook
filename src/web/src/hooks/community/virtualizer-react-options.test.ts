import { describe, expect, it } from "vitest"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "./virtualizer-react-options"

describe("COMMUNITY_VIRTUALIZER_REACT_OPTIONS", () => {
  it("disables flushSync for React 19 compatibility while keeping direct DOM geometry", () => {
    expect(COMMUNITY_VIRTUALIZER_REACT_OPTIONS).toEqual({
      useFlushSync: false,
      directDomUpdates: true,
    })
  })
})
