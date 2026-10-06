import { createElement } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { useDmSeqContext } from "./use-dm-seq-context"

const navigation = vi.hoisted(() => ({
  pathname: "/c/me/dm1",
  search: "",
  router: { replace: vi.fn() },
}))
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => navigation.router,
}))

function Context({ dmId = "dm1", historyAllowed = true, navigationAllowed = true }: {
  dmId?: string
  historyAllowed?: boolean
  navigationAllowed?: boolean
}) {
  const [seq, setContextSeq] = useAtom(useCreateAtom<number | null>(null))
  useDmSeqContext({ dmId, historyAllowed, navigationAllowed, setContextSeq })
  return createElement("div", null,
    createElement("output", null, seq === null ? "closed" : `target ${seq}`),
    createElement("button", { onClick: () => setContextSeq(null) }, "Close"),
  )
}

beforeEach(() => {
  navigation.pathname = "/c/me/dm1"
  navigation.search = ""
  navigation.router.replace.mockReset()
})

describe("mounted DM sequence URL intents", () => {
  it("consumes initial, different and repeated targets after ordinary Close", () => {
    navigation.search = "seq=39&panel=details"
    const view = render(createElement(Context))
    expect(screen.getByText("target 39")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/c/me/dm1?panel=details", { scroll: false })

    navigation.search = "panel=details"
    view.rerender(createElement(Context))
    fireEvent.click(screen.getByText("Close"))
    expect(screen.getByText("closed")).toBeTruthy()
    view.rerender(createElement(Context))
    expect(screen.getByText("closed")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenCalledTimes(1)

    navigation.search = "seq=105&panel=details"
    view.rerender(createElement(Context))
    expect(screen.getByText("target 105")).toBeTruthy()
    navigation.search = "panel=details"
    view.rerender(createElement(Context))
    fireEvent.click(screen.getByText("Close"))
    navigation.search = "seq=105&panel=details"
    view.rerender(createElement(Context))
    expect(screen.getByText("target 105")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenCalledTimes(3)
  })

  it("waits for current history and navigation qualification before consuming", () => {
    navigation.search = "seq=39"
    const view = render(createElement(Context, { historyAllowed: false }))
    expect(screen.getByText("closed")).toBeTruthy()
    view.rerender(createElement(Context, { navigationAllowed: false }))
    expect(navigation.router.replace).not.toHaveBeenCalled()
    view.rerender(createElement(Context))
    expect(screen.getByText("target 39")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenCalledOnce()
  })

  it.each(["history", "navigation"])("retires an open target on %s denial", (denial) => {
    navigation.search = "seq=39"
    const view = render(createElement(Context))
    navigation.search = ""
    view.rerender(createElement(Context, {
      historyAllowed: denial !== "history",
      navigationAllowed: denial !== "navigation",
    }))
    expect(screen.getByText("closed")).toBeTruthy()
    view.rerender(createElement(Context))
    expect(screen.getByText("closed")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenCalledOnce()
  })

  it("handles history URL changes only for the current keyed DM owner", () => {
    const view = render(createElement(Context, { key: "viewer1/dm1" }))
    navigation.search = "seq=39"
    view.rerender(createElement(Context, { key: "viewer1/dm1" }))
    expect(screen.getByText("target 39")).toBeTruthy()
    navigation.search = ""
    view.rerender(createElement(Context, { key: "viewer1/dm1" }))
    fireEvent.click(screen.getByText("Close"))
    navigation.search = "seq=105"
    view.rerender(createElement(Context, { key: "viewer1/dm1" }))
    expect(screen.getByText("target 105")).toBeTruthy()

    navigation.pathname = "/c/me/dm2"
    view.rerender(createElement(Context, { key: "viewer2/dm1" }))
    expect(screen.getByText("closed")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenCalledTimes(2)
    navigation.search = "seq=7"
    view.rerender(createElement(Context, { key: "viewer2/dm2", dmId: "dm2" }))
    expect(screen.getByText("target 7")).toBeTruthy()
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/c/me/dm2", { scroll: false })
  })

  it.each(["", "0", "-1", "1.5", "nope", "Infinity"])("ignores invalid seq %s", (seq) => {
    navigation.search = `seq=${seq}`
    render(createElement(Context))
    expect(screen.getByText("closed")).toBeTruthy()
    expect(navigation.router.replace).not.toHaveBeenCalled()
  })
})
