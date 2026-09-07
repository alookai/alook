import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { ProfileAvatar } from "./profile-avatar"

function mockImageReadiness(complete: boolean, naturalWidth: number, naturalHeight: number) {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(complete)
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(naturalWidth)
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(naturalHeight)
}

function setLoadedImageMetrics(image: HTMLImageElement) {
  Object.defineProperties(image, {
    decode: { configurable: true, value: () => Promise.resolve() },
    naturalWidth: { configurable: true, value: 40 },
    naturalHeight: { configurable: true, value: 40 },
  })
}

function photo(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('[data-slot="avatar-image"]')!
}

function placeholder(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-slot="avatar-photo-placeholder"]')!
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("ProfileAvatar photo errors", () => {
  it("reveals a cached photo whose load event completed before hydration", async () => {
    mockImageReadiness(true, 40, 40)
    const rendered = render(createElement(ProfileAvatar, {
      label: "Ada",
      src: "https://cdn.example.com/cached.png",
      seed: "user_1",
    }))

    await waitFor(() => expect(photo(rendered.container))
      .toHaveAttribute("data-avatar-photo-state", "ready"))
    expect(placeholder(rendered.container)).not.toHaveAttribute("data-avatar-photo-placeholder")
    expect(placeholder(rendered.container)).not.toHaveClass("animate-pulse")
  })

  it("shows a static neutral placeholder when a cached photo failed before hydration", () => {
    mockImageReadiness(true, 0, 0)
    const rendered = render(createElement(ProfileAvatar, {
      label: "Ada",
      src: "https://cdn.example.com/failed-before-hydration.png",
      seed: "user_1",
    }))

    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "failed")
    expect(placeholder(rendered.container)).toHaveAttribute("data-avatar-photo-placeholder", "failed")
    expect(placeholder(rendered.container)).not.toHaveClass("animate-pulse")
    expect(rendered.container.querySelector('[data-slot="avatar-fallback"]')).not.toBeInTheDocument()
    expect(rendered.container.querySelector("svg")).not.toBeInTheDocument()
    expect(rendered.container).not.toHaveTextContent("A")
  })

  it("stops the neutral skeleton after the photo reports an error", () => {
    const rendered = render(createElement(ProfileAvatar, {
      label: "Ada",
      src: "https://cdn.example.com/missing.png",
      seed: "user_1",
    }))

    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "pending")
    expect(placeholder(rendered.container)).toHaveAttribute("data-avatar-photo-placeholder", "pending")
    fireEvent.error(photo(rendered.container))

    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "failed")
    expect(placeholder(rendered.container)).toHaveAttribute("data-avatar-photo-placeholder", "failed")
    expect(placeholder(rendered.container)).not.toHaveClass("animate-pulse")
    expect(rendered.container.querySelector('[data-slot="avatar-fallback"]')).not.toBeInTheDocument()
  })

  it("reveals a loaded photo over its retained neutral placeholder", async () => {
    vi.useFakeTimers()
    const rendered = render(createElement(ProfileAvatar, {
      label: "Ada",
      src: "https://cdn.example.com/ada.png",
      seed: "user_1",
    }))

    setLoadedImageMetrics(photo(rendered.container))
    fireEvent.load(photo(rendered.container))
    await act(async () => { await Promise.resolve() })

    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "ready")
    expect(placeholder(rendered.container)).not.toHaveAttribute("data-avatar-photo-placeholder")
    expect(placeholder(rendered.container)).not.toHaveClass("animate-pulse")

    await act(async () => vi.advanceTimersByTime(5_000))
    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "ready")
  })

  it("settles a pending photo to a static placeholder after the readiness timeout", async () => {
    vi.useFakeTimers()
    const rendered = render(createElement(ProfileAvatar, {
      label: "Ada",
      src: "https://cdn.example.com/never.png",
      seed: "user_1",
    }))

    await act(async () => vi.advanceTimersByTime(5_000))

    const image = photo(rendered.container)
    expect(image).toHaveAttribute("data-avatar-photo-state", "failed")
    expect(placeholder(rendered.container)).toHaveAttribute("data-avatar-photo-placeholder", "failed")
    expect(placeholder(rendered.container)).not.toHaveClass("animate-pulse")

    setLoadedImageMetrics(image)
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "failed")
  })

  it("retries from a neutral skeleton when the photo source changes", () => {
    const props = { label: "Ada", seed: "user_1" }
    const rendered = render(createElement(ProfileAvatar, {
      ...props,
      src: "https://cdn.example.com/first.png",
    }))
    fireEvent.error(photo(rendered.container))

    rendered.rerender(createElement(ProfileAvatar, {
      ...props,
      src: "https://cdn.example.com/second.png",
    }))

    expect(photo(rendered.container)).toHaveAttribute("src", "https://cdn.example.com/second.png")
    expect(photo(rendered.container)).toHaveAttribute("data-avatar-photo-state", "pending")
    expect(placeholder(rendered.container)).toHaveAttribute("data-avatar-photo-placeholder", "pending")
    expect(placeholder(rendered.container)).toHaveClass("animate-pulse")
    expect(rendered.container.querySelector('[data-slot="avatar-fallback"]')).not.toBeInTheDocument()
  })
})
