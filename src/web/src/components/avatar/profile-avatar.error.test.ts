import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { ProfileAvatar } from "./profile-avatar"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe("ProfileAvatar photo errors", () => {
  it("shows the fallback only after the photo reports an error", async () => {
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/missing.png",
        seed: "user_1",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    await act(async () => {
      image.props.onError()
    })

    expect(renderer!.root.findAllByProps({ "data-slot": "avatar-image" })).toHaveLength(0)
    expect(JSON.stringify(renderer!.toJSON())).toContain('"children":["A"]')
  })
})
