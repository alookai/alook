import { queries, visibilityIsDmParticipant, type Database } from "@alook/shared"
import { requireMessageSurfaceCommunicationAccess } from "./permissions"

export async function pageAccessRole(db: Database, artifactId: string, subject: string) {
  const context = typeof queries.communityPage.getPageAccessContext === "function"
    ? await queries.communityPage.getPageAccessContext(db, artifactId, subject)
    : {
        page: await queries.communityPage.getReadableResource(db, artifactId, subject, "artifactId"),
        channels: null,
      }
  if (!context.page) return null
  if (context.page.botId === subject) return "editor"
  const channels = context.channels ?? await queries.communityPage.listReadablePageChannels(db, artifactId, subject)
  // Non-DM channels returned by listReadablePageChannels already satisfied
  // activeActor + channelReadableSql (the exact predicate of requireChannelMember).
  if (channels.some((entry) => entry.channelType !== undefined && !visibilityIsDmParticipant(entry.channelType))) {
    return "editor"
  }
  for (const { channelId } of channels) {
    if ((await requireMessageSurfaceCommunicationAccess(db, channelId, subject)).ok) return "editor"
  }
  return "viewer"
}
