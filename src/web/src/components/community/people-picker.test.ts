import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  PeoplePickerBody,
  PeoplePickerHeader,
  resolvePeoplePickerViewState,
} from "./people-picker"

function state(overrides: Partial<Parameters<typeof resolvePeoplePickerViewState>[0]> = {}) {
  return resolvePeoplePickerViewState({
    resolved: false,
    loading: true,
    error: false,
    sourceCount: 0,
    visibleCount: 0,
    query: "",
    ...overrides,
  })
}

describe("resolvePeoplePickerViewState", () => {
  it("never treats an unresolved fallback array as empty", () => {
    expect(state()).toBe("loading")
    expect(state({ loading: false })).toBe("loading")
  })

  it("shows a first-load error before empty", () => {
    expect(state({ loading: false, error: true })).toBe("error")
  })

  it("distinguishes resolved empty, local search-empty, and ready rows", () => {
    expect(state({ resolved: true, loading: false })).toBe("empty")
    expect(state({
      resolved: true,
      loading: false,
      sourceCount: 2,
      visibleCount: 0,
      query: "nobody",
    })).toBe("search-empty")
    expect(state({
      resolved: true,
      loading: false,
      sourceCount: 2,
      visibleCount: 2,
    })).toBe("ready")
  })

  it("keeps cached content usable during background fetching or error", () => {
    expect(state({
      resolved: true,
      loading: true,
      error: true,
      sourceCount: 1,
      visibleCount: 1,
    })).toBe("ready")
  })
})

describe("PeoplePickerBody", () => {
  it("renders a retry action for a terminal first-load error", () => {
    const html = renderToStaticMarkup(createElement(PeoplePickerBody, {
      state: "error",
      loading: createElement("span", null, "loading"),
      errorMessage: "Couldn't load people.",
      emptyMessage: "Nobody here.",
      retrying: false,
      onRetry: vi.fn(),
    }, createElement("span", null, "ready")))
    expect(html).toContain("Couldn&#x27;t load people.")
    expect(html).toContain(">Retry<")
    expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/)
  })

  it("keeps the error frame and disables Retry while refetching", () => {
    const html = renderToStaticMarkup(createElement(PeoplePickerBody, {
      state: "error",
      loading: createElement("span", null, "loading"),
      errorMessage: "Couldn't load people.",
      emptyMessage: "Nobody here.",
      retrying: true,
      onRetry: vi.fn(),
    }, createElement("span", null, "ready")))
    expect(html).toContain("Retrying…")
    expect(html).toContain("disabled")
  })
})

describe("PeoplePickerHeader", () => {
  it("reserves the close-button column while keeping the title truncatable", () => {
    const html = renderToStaticMarkup(createElement(PeoplePickerHeader, {
      title: "A very long picker title",
      subtitle: "Picker context",
    }))
    expect(html).toContain("min-w-0")
    expect(html).toContain("pr-12")
    expect(html).toContain("truncate")
    expect(html).toContain("A very long picker title")
  })
})
