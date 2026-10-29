import { CommunitySelfProfileReadSchema } from "@alook/shared"

export function assertCaseProfileBaseline(value: unknown, actor: { userId: string; name: string }, key: string) {
  const profile = CommunitySelfProfileReadSchema.parse(value)
  if (profile.id !== actor.userId || profile.name !== actor.name) throw new Error(`Case baseline ${key} has a different profile identity`)
  if (profile.aboutMe !== "" || profile.avatarVersion !== 0 || profile.bannerColor !== null || profile.statusEmoji !== null || profile.statusText !== null) throw new Error(`Case baseline ${key} has modified profile defaults`)
}
