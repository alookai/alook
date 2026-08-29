import type { CommunityIdentityUpdate, CommunityProfileUpdate } from "@alook/shared"
import type { CommunityWsHandlerContext } from "@/hooks/community/community-ws/handler-context"

export function handleIdentityUpdate(
  event: CommunityIdentityUpdate,
  { wsStore }: CommunityWsHandlerContext,
) {
  wsStore.patchProfiles(wsStore.beginProfileSnapshot(), [{
    id: event.userId,
    avatar: { avatar: event.avatar, avatarVersion: event.avatarVersion },
  }])
}

export function handleProfileUpdate(
  event: CommunityProfileUpdate,
  { wsStore }: CommunityWsHandlerContext,
) {
  wsStore.patchProfiles(wsStore.beginProfileSnapshot(), [{
    id: event.userId,
    identityAbout: {
      name: event.name,
      discriminator: event.discriminator,
      aboutMe: event.aboutMe,
      bannerColor: event.bannerColor,
      kind: event.kind,
      ownerUserId: event.ownerUserId,
    },
  }])
}
