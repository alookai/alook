import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { ProfileAvatar } from "@/components/avatar"
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
  DropdownMenu: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  DropdownMenuGroup: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  DropdownMenuSeparator: () => React.createElement("hr"),
  DropdownMenuTrigger: ({ children, render }: React.PropsWithChildren<{ render: React.ReactElement }>) =>
    React.cloneElement(render, {}, children),
}))

describe("NavUser avatar", () => {
  it("uses the session photo in both the trigger and open menu identity", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(NavUser))
    })

    const avatars = renderer.root.findAllByType(ProfileAvatar)
    expect(avatars).toHaveLength(2)
    expect(avatars.map((avatar) => ({
      src: avatar.props.src,
      seed: avatar.props.seed,
      size: avatar.props.size,
    }))).toEqual([
      { src: "https://cdn.example.com/ada.png", seed: "user_1", size: 28 },
      { src: "https://cdn.example.com/ada.png", seed: "user_1", size: 28 },
    ])

    const trigger = renderer.root.findByProps({ "data-testid": "nav-user-trigger" })
    expect(trigger.props["aria-label"]).toBe("Open user menu for Ada")
    expect(JSON.stringify(renderer.toJSON()).match(/data-avatar-kind\":\"photo/g)).toHaveLength(2)
  })
})
