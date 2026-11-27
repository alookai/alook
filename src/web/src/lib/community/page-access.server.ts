import { queries, type Database } from "@alook/shared"
import { requireMessageSurfaceCommunicationAccess } from "./permissions"

export async function pageAccessRole(db: Database, artifactId: string, subject: string) {
  const page = await queries.communityPage.getReadableResource(db, artifactId, subject, "artifactId")
  if (!page) return null
  if (page.botId === subject) return "editor"
  const channels = await queries.communityPage.listReadablePageChannels(db, artifactId, subject)
  for (const { channelId } of channels) {
    if ((await requireMessageSurfaceCommunicationAccess(db, channelId, subject)).ok) return "editor"
  }
  return "viewer"
}
