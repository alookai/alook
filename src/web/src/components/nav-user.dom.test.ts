import { cloneElement, createElement, type PropsWithChildren, type ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { NavUser } from "./nav-user"

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  clearAccount: vi.fn(),
  signOut: vi.fn(),
  session: {
    data: {
      user: {
        id: "user_1",
        name: "Ada",
        discriminator: "0042",
        email: "ada@example.com",
        image: "https://cdn.example.com/ada.png",
      },
    },
    isPending: false,
  },
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.routerPush }) }))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => mocks.session,
  signOut: mocks.signOut,
}))

beforeEach(() => {
  mocks.routerPush.mockReset()
  mocks.clearAccount.mockReset().mockResolvedValue(undefined)
  mocks.signOut.mockReset().mockResolvedValue(undefined)
})
vi.mock("@/lib/account-persistence", () => ({
  clearBrowserPersistenceForAccount: mocks.clearAccount,
}))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuGroup: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuItem: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) =>
    createElement("button", props, children),
  DropdownMenuLabel: ({ children }: PropsWithChildren) => createElement("div", null, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children, render: trigger }:
    PropsWithChildren<{ render: ReactElement }>) => cloneElement(trigger, {}, children),
}))

describe("NavUser avatar", () => {
  it("uses the session photo in both the trigger and open menu identity", async () => {
    render(createElement(NavUser))

    await waitFor(() => expect(screen.getByTestId("nav-user-trigger")).toBeVisible())
    const triggerAvatar = screen.getByTestId("nav-user-trigger-avatar")
    const menuAvatar = screen.getByTestId("nav-user-menu-avatar")
    for (const avatar of [triggerAvatar, menuAvatar]) {
      expect(avatar).toHaveAttribute("data-avatar-kind", "photo")
      expect(avatar).toHaveStyle({ width: "28px", height: "28px" })
    }
    expect(screen.getByTestId("nav-user-trigger"))
      .toHaveAttribute("aria-label", "Open user menu for Ada")
    expect(renderedPhotos()).toEqual([
      "https://cdn.example.com/ada.png",
      "https://cdn.example.com/ada.png",
    ])
  })

  it("clears both persistence domains for the current account before logout", async () => {
    const order: string[] = []
    mocks.clearAccount.mockImplementation(async () => { order.push("clear") })
    mocks.signOut.mockImplementation(async () => { order.push("signOut") })
    mocks.routerPush.mockImplementation(() => { order.push("redirect") })
    render(createElement(NavUser))

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }))

    await waitFor(() => expect(order).toEqual(["clear", "signOut", "redirect"]))
    expect(mocks.clearAccount).toHaveBeenCalledWith("user_1")
  })
})

function renderedPhotos(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('[data-remote-image-kind="identity"]'),
    (image) => image.src,
  )
}
