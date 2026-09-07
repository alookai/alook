import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@/test/react-dom-harness"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { MembersTab } from "./members-tab"

const mocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listInvites: vi.fn(),
  avatars: [] as Array<{ src?: string | null; seed?: string | null; size?: number }>,
}))

vi.mock("@/components/avatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/avatar")>()
  return {
    ...actual,
    ProfileAvatar: (props: React.ComponentProps<typeof actual.ProfileAvatar>) => {
      mocks.avatars.push(props)
      return React.createElement(actual.ProfileAvatar, props)
    },
  }
})

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({ workspaceId: "workspace_1" }),
}))

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user_beam" } } }),
}))

vi.mock("@/lib/api", () => ({
  listMembers: mocks.listMembers,
  listInvites: mocks.listInvites,
  removeMember: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
}))

vi.mock("@/lib/analytics", () => ({ trackTeamMemberInvited: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement("span", null, children),
}))

describe("MembersTab avatars", () => {
  beforeEach(() => {
    mocks.avatars.length = 0
    mocks.listInvites.mockResolvedValue([])
    mocks.listMembers.mockResolvedValue([
      {
        id: "membership_1",
        user_id: "user_beam",
        role: "owner",
        name: "Beam User",
        email: "beam@example.com",
        image: serializeBeamSeed("stored-face"),
      },
      {
        id: "membership_2",
        user_id: "user_photo",
        role: "member",
        name: "Photo User",
        email: "photo@example.com",
        image: "https://cdn.example.com/photo.png",
      },
      {
        id: "membership_3",
        user_id: "user_generated",
        role: "member",
        name: "Generated User",
        email: "generated@example.com",
        image: null,
      },
    ])
  })

  it("passes each member image and stable id through ProfileAvatar", async () => {
    const rendered = render(React.createElement(MembersTab))

    await waitFor(() => expect(mocks.avatars).toHaveLength(3))
    expect(mocks.avatars.map(({ src, seed, size }) => ({ src, seed, size }))).toEqual([
      { src: serializeBeamSeed("stored-face"), seed: "user_beam", size: 28 },
      { src: "https://cdn.example.com/photo.png", seed: "user_photo", size: 28 },
      { src: null, seed: "user_generated", size: 28 },
    ])

    expect(rendered.container.querySelectorAll('[data-avatar-kind="beam"]')).toHaveLength(2)
    expect(rendered.container.querySelector('[data-avatar-kind="photo"]')).toBeInTheDocument()
  })
})
