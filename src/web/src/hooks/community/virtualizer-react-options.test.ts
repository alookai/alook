import { describe, expect, it } from "vitest"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "./virtualizer-react-options"

describe("COMMUNITY_VIRTUALIZER_REACT_OPTIONS", () => {
  it("keeps lifecycle measurements synchronous through direct DOM updates without React flushSync", () => {
    expect(COMMUNITY_VIRTUALIZER_REACT_OPTIONS).toEqual({
      useFlushSync: false,
      directDomUpdates: true,
    })
  })
})
