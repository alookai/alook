import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProfileAvatar } from "./profile-avatar"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function imageEvent() {
  return {
    currentTarget: {
      naturalWidth: 40,
      naturalHeight: 40,
      decode: () => Promise.resolve(),
    },
  }
}

describe("ProfileAvatar photo errors", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined

  afterEach(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount())
      renderer = undefined
    }
    vi.useRealTimers()
  })

  it("reveals a cached photo whose load event completed before hydration", async () => {
    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/cached.png",
        seed: "user_1",
      }), {
        createNodeMock: (element) => element.type === "img"
          ? { complete: true, naturalWidth: 40, naturalHeight: 40 }
          : null,
      })
    })

    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "ready",
    })
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBeUndefined()
    expect(placeholder.props.className).not.toContain("animate-pulse")
  })

  it("shows a static neutral placeholder when a cached photo failed before hydration", async () => {
    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/failed-before-hydration.png",
        seed: "user_1",
      }), {
        createNodeMock: (element) => element.type === "img"
          ? { complete: true, naturalWidth: 0, naturalHeight: 0 }
          : null,
      })
    })

    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "failed",
    })
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBe("failed")
    expect(placeholder.props.className).not.toContain("animate-pulse")
    expect(renderer!.root.findAllByProps({ "data-slot": "avatar-fallback" })).toHaveLength(0)
    expect(renderer!.root.findAll((node) => node.type === "svg")).toHaveLength(0)
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('"children":["A"]')
  })

  it("stops the neutral skeleton after the photo reports an error", async () => {
    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/missing.png",
        seed: "user_1",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    expect(image.props["data-avatar-photo-state"]).toBe("pending")
    expect(renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" }).props).toMatchObject({
      "data-avatar-photo-placeholder": "pending",
    })

    await act(async () => {
      image.props.onError()
    })

    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "failed",
    })
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBe("failed")
    expect(placeholder.props.className).not.toContain("animate-pulse")
    expect(renderer!.root.findAllByProps({ "data-slot": "avatar-fallback" })).toHaveLength(0)
  })

  it("reveals a loaded photo over its retained neutral placeholder", async () => {
    vi.useFakeTimers()
    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/ada.png",
        seed: "user_1",
      }))
    })

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    await act(async () => {
      image.props.onLoad(imageEvent())
      await Promise.resolve()
    })

    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "ready",
    })
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBeUndefined()
    expect(placeholder.props.className).not.toContain("animate-pulse")

    await act(async () => vi.advanceTimersByTime(5_000))
    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "ready",
    })
  })

  it("settles a pending photo to a static placeholder after the readiness timeout", async () => {
    vi.useFakeTimers()
    await act(async () => {
      renderer = TestRenderer.create(createElement(ProfileAvatar, {
        label: "Ada",
        src: "https://cdn.example.com/never.png",
        seed: "user_1",
      }))
    })

    await act(async () => vi.advanceTimersByTime(5_000))

    const image = renderer!.root.findByProps({ "data-slot": "avatar-image" })
    expect(image.props["data-avatar-photo-state"]).toBe("failed")
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBe("failed")
    expect(placeholder.props.className).not.toContain("animate-pulse")

    await act(async () => {
      image.props.onLoad(imageEvent())
      await Promise.resolve()
    })
    expect(renderer!.root.findByProps({ "data-slot": "avatar-image" }).props).toMatchObject({
      "data-avatar-photo-state": "failed",
    })
  })

  it("retries from a neutral skeleton when the photo source changes", async () => {
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
    const placeholder = renderer!.root.findByProps({ "data-slot": "avatar-photo-placeholder" })
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBe("pending")
    expect(placeholder.props.className).toContain("animate-pulse")
    expect(renderer!.root.findAllByProps({ "data-slot": "avatar-fallback" })).toHaveLength(0)
  })
})
