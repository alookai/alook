import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it } from "vitest"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "./profile-preview"
import {
  useCommunityProfile,
  useCommunityWsStore,
  useProfilesByUserId,
} from "./ws"

const activeRenderers: TestRenderer.ReactTestRenderer[] = []

function ProfileProbe({ userId }: { userId: string }) {
  const profile = useCommunityProfile(userId)
  const profiles = useProfilesByUserId()
  return createElement("output", {
    "data-profile-name": profile?.name,
    "data-map-name": profiles.get(userId)?.name,
  })
}

function renderProbe(userId: string, previewProfiles?: ReadonlyMap<string, CommunityProfile>) {
  const probe = createElement(ProfileProbe, { userId })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      previewProfiles
        ? createElement(CommunityPreviewProfileOwner, { profiles: previewProfiles }, probe)
        : probe,
    )
  })
  activeRenderers.push(renderer)
  return renderer.root.findByType("output")
}

afterEach(() => {
  act(() => {
    for (const renderer of activeRenderers) renderer.unmount()
  })
  activeRenderers.length = 0
  useCommunityWsStore.getState().reset()
})

describe("CommunityPreviewProfileOwner", () => {
  it("owns profile reads inside its subtree without mutating the live store", () => {
    const liveProfile = { id: "shared", name: "Live name" }
    const liveProfiles = new Map([[liveProfile.id, liveProfile]])
    useCommunityWsStore.setState({ profilesByUserId: liveProfiles })
    const previewProfiles = new Map([["shared", { id: "shared", name: "Preview name" }]])

    const owned = renderProbe("shared", previewProfiles)

    expect(owned.props).toMatchObject({
      "data-profile-name": "Preview name",
      "data-map-name": "Preview name",
    })
    expect(useCommunityWsStore.getState().profilesByUserId).toBe(liveProfiles)
    expect(useCommunityWsStore.getState().profilesByUserId.get("shared")?.name).toBe("Live name")
  })

  it("does not leak live identities into an incomplete preview owner", () => {
    useCommunityWsStore.setState({
      profilesByUserId: new Map([["live-only", { id: "live-only", name: "Live only" }]]),
    })

    const owned = renderProbe("live-only", new Map())
    const live = renderProbe("live-only")

    expect(owned.props["data-profile-name"]).toBeUndefined()
    expect(owned.props["data-map-name"]).toBeUndefined()
    expect(live.props).toMatchObject({
      "data-profile-name": "Live only",
      "data-map-name": "Live only",
    })
  })
})
