import { cloneElement, createElement, type PropsWithChildren, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@/test/react-dom-harness"
import { NavUser } from "./nav-user"

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
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
  signOut: vi.fn(),
}))
vi.mock("@/lib/chat-cache", () => ({ clearAllCache: vi.fn() }))
vi.mock("@/lib/query-persister", () => ({ clearPersistedCache: vi.fn() }))
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
})

function renderedPhotos(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('[data-remote-image-kind="identity"]'),
    (image) => image.src,
  )
}
