import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { WorkspaceOverview } from "@/lib/api"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { TeamAccess } from "./team-access"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/contexts/workspace-context", () => ({ useWorkspace: () => ({ slug: "demo" }) }))

function overview(): WorkspaceOverview {
  return {
    email_stats: { inbound: 0, outbound: 0, unread: 0, rejected: 0 },
    task_stats: { completed: 0, failed: 0, cancelled: 0, queued: 0, stale: 0 },
    recent_tasks: [],
    conversation_counts: {},
    pending_invites: 0,
    calendar_events: [],
    members: [
      {
        id: "membership_1",
        user_id: "user_beam",
        role: "owner",
        name: "Beam User",
        email: "beam@example.com",
        image: serializeBeamSeed("stored-face"),
        created_at: "2026-08-14T00:00:00Z",
      },
      {
        id: "membership_2",
        user_id: "user_photo",
        role: "member",
        name: "Photo User",
        email: "photo@example.com",
        image: "https://cdn.example.com/photo.png",
        created_at: "2026-08-14T00:00:00Z",
      },
      {
        id: "membership_3",
        user_id: "user_generated",
        role: "member",
        name: "Generated User",
        email: "generated@example.com",
        image: null,
        created_at: "2026-08-14T00:00:00Z",
      },
    ],
  }
}

describe("TeamAccess avatars", () => {
  it("renders photo, stored beam, and stable-id avatars at the existing row size", () => {
    const html = renderToStaticMarkup(createElement(TeamAccess, { overview: overview() }))

    expect(html).toContain('data-testid="team-access-avatar-user_beam"')
    expect(html).toContain('data-testid="team-access-avatar-user_photo"')
    expect(html).toContain('data-testid="team-access-avatar-user_generated"')
    expect(html.match(/data-avatar-kind="beam"/g)).toHaveLength(2)
    expect(html).toContain('data-avatar-kind="photo"')
    expect(html).not.toContain('src="avatar:beam:stored-face"')
    expect(html).toContain("width:28px;height:28px")
  })
})
