import { afterEach, expect, it, vi } from "vitest"
import { ThemeProvider, useTheme } from "next-themes"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import { tid } from "@/lib/community/testids"
import { HtmlAttachmentPreview } from "./html-attachment-preview"

const storageKey = "html-preview-theme-regression"
const owners: ReturnType<typeof createApplicationOwner>[] = []
afterEach(() => {
  for (const owner of owners.splice(0)) owner.queryClient.clear()
  localStorage.removeItem(storageKey)
  vi.restoreAllMocks()
})

function ThemeControls() {
  const { setTheme } = useTheme()
  return <><button onClick={() => setTheme("light")}>Light</button><button onClick={() => setTheme("dark")}>Dark</button></>
}

it("syncs the loaded iframe scheme and committed CSS tokens through the real theme provider in both directions", async () => {
  const root = document.documentElement
  const originalClass = root.getAttribute("class"), originalStyle = root.getAttribute("style")
  const sheet = document.createElement("style")
  sheet.textContent = ":root{--background:#ffffff;--foreground:#102030;--card:#f1f2f3;--secondary:#e1e2e3;--primary:#112233}:root.dark{--background:#121314;--foreground:#e1e2e3;--card:#222324;--secondary:#323334;--primary:#f1f2f3}"
  document.head.appendChild(sheet)
  localStorage.setItem(storageKey, "light")
  const owner = createApplicationOwner("theme-viewer")
  owners.push(owner)
  try {
    const view = render(<ApplicationOwnerProvider owner={owner}><ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey={storageKey}><ThemeControls /><HtmlAttachmentPreview attachment={{ id: "theme-html", kind: "file", name: "theme.html", url: "/api/community/channels/c1/attachments/theme-html", contentType: "text/html", size: "100 B" }} /></ThemeProvider></ApplicationOwnerProvider>)
    const frame = view.getByTestId(tid.htmlPreviewFrame("theme-html")) as HTMLIFrameElement
    expect(frame.style.colorScheme).toBe("")
    expect(frame).toHaveClass("scheme-light")
    fireEvent.load(frame)
    await waitFor(() => expect(frame.style.colorScheme).toBe("light"))
    const post = vi.spyOn(frame.contentWindow!, "postMessage")
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type: "alook-html-ready" }, source: frame.contentWindow, origin: "null" })) })
    for (const mode of ["dark", "light"] as const) {
      fireEvent.click(view.getByRole("button", { name: mode === "dark" ? "Dark" : "Light" }))
      await waitFor(() => expect(root).toHaveClass(mode))
      await waitFor(() => expect(frame.style.colorScheme).toBe(mode))
      await waitFor(() => {
        const style = getComputedStyle(root)
        const variables = Object.fromEntries(["background", "foreground", "card", "secondary", "primary"].map((name) => [`--${name}`, style.getPropertyValue(`--${name}`).trim()]))
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "alook-html-theme", dark: mode === "dark", variables: expect.objectContaining(variables) }), "*")
      })
      expect(view.getByTestId(tid.htmlPreviewFrame("theme-html"))).toBe(frame)
    }
  } finally {
    sheet.remove()
    if (originalClass === null) root.removeAttribute("class"); else root.setAttribute("class", originalClass)
    if (originalStyle === null) root.removeAttribute("style"); else root.setAttribute("style", originalStyle)
  }
})
