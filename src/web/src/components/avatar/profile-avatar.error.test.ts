import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { ProfileAvatar } from "./profile-avatar"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe("ProfileAvatar photo errors", () => {
  it("keeps the first-frame fallback after the photo reports an error", async () => {
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/missing.png",
        seed: "user_1",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    expect(image.props["data-avatar-photo-state"]).toBe("pending")
    expect(JSON.stringify(renderer!.toJSON())).toContain('"children":["A"]')

    await act(async () => {
      image.props.onError()
    })

    expect(renderer!.root.findAllByProps({ "data-slot": "avatar-image" })).toHaveLength(0)
    expect(JSON.stringify(renderer!.toJSON())).toContain('"children":["A"]')
  })

  it("reveals a loaded photo over its retained fallback", async () => {
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/ada.png",
        seed: "user_1",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    await act(async () => {
      image.props.onLoad()
    })

    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "ready",
    })
    expect(renderer!.root.findAll((node) => (
      node.type === "span" && node.props["data-slot"] === "avatar-fallback"
    ))).toHaveLength(1)
  })

  it("retries from the fallback when the photo source changes", async () => {
    let renderer: TestRenderer.ReactTestRenderer
    const props = {
      label: "Ada",
      seed: "user_1",
    }

    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        ...props,
        src: "https://cdn.example.com/first.png",
      }))
    })
    await act(async () => {
      renderer!.root.findByProps({ "data-slot": "avatar-image" }).props.onError()
    })

    await act(async () => {
      renderer!.update(createElement(ProfileAvatar, {
        ...props,
        src: "https://cdn.example.com/second.png",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    expect(image.props).toMatchObject({
      src: "https://cdn.example.com/second.png",
      "data-avatar-photo-state": "pending",
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('"children":["A"]')
  })
})
