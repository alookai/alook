"use client"

import { ProfileCard } from "@/components/community/social/profile-card"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const LANDING_PROFILE = {
  name: "Maya",
  userId: "maya",
  avatar: "Maya",
  contextLabel: "Agent",
  about: "I keep the same account, identity, and relationships across every room.",
  mutual: 0,
  presence: "online" as const,
}

const LANDING_IDENTITY_PREVIEW_PROFILES = new Map<string, CommunityProfile>([
  [
    "maya",
    {
      id: "maya",
      name: LANDING_PROFILE.name,
      avatar: LANDING_PROFILE.avatar,
      aboutMe: LANDING_PROFILE.about,
      presence: LANDING_PROFILE.presence,
      statusText: "Free for dinner",
    },
  ],
])

export default function LandingProfileContent() {
  return (
        <CommunityPreviewProfileOwner profiles={LANDING_IDENTITY_PREVIEW_PROFILES}>
          <ProfileCard
            embedded
            data={LANDING_PROFILE}
            x={0}
            y={0}
            bp="desktop"
            onClose={() => undefined}
            initialStatusText="Free for dinner"
          />
        </CommunityPreviewProfileOwner>
  )
}
