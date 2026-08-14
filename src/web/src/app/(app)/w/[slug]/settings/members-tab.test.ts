import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProfileAvatar } from "@/components/avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { MembersTab } from "./members-tab"

const mocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listInvites: vi.fn(),
}))

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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(MembersTab))
    })

    const avatars = renderer.root.findAllByType(ProfileAvatar)
    expect(avatars.map((avatar) => ({
      src: avatar.props.src,
      seed: avatar.props.seed,
      size: avatar.props.size,
    }))).toEqual([
      { src: serializeBeamSeed("stored-face"), seed: "user_beam", size: 28 },
      { src: "https://cdn.example.com/photo.png", seed: "user_photo", size: 28 },
      { src: null, seed: "user_generated", size: 28 },
    ])

    const html = JSON.stringify(renderer.toJSON())
    expect(html.match(/data-avatar-kind\":\"beam/g)).toHaveLength(2)
    expect(html).toContain('data-avatar-kind\":\"photo')
  })
})
