import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("DM page loading ownership", () => {
  it("keeps full-frame and message-body ownership separate", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).toContain("fullFramePending: !hasDm && dmsLoading")
    expect(source).toContain("notFound: !hasDm && !dmsLoading")
    expect(source).toContain("messageBodyLoading: hasDm && messagesLoading")
    expect(source).not.toContain("currentChannelMatches")
    expect(source).not.toContain("readSnapshotFetching ||\n      messagesLoading")
    expect(source).toContain("waitForAnchor: true")
    expect(source).toContain("if (navigationBlocked)")
    expect(source).toContain("if (loadingOwnership.fullFramePending)")
    expect(source).toContain("<DmHeader\n")
    expect(source).toContain("<Composer\n")
    expect(source).toContain("<ConversationFooterShell\n")
    expect(source).toContain("<ConversationFooterSlotProvider>")
    expect(source).toContain('data-slot="community-conversation-surface"')
    expect(source).toContain("data-channel-id={dmId}")
    expect(source).not.toContain("composerOverlap")
    expect(source).not.toContain("onOverlapChange")
    expect(source).toContain("typingUsers={typingUsers.map((id) => typingNames[id] ?? resolveUserName(id))}")
    const messageListProps = source.split("          <MessageList\n")[1]?.split("          />")[0]
    expect(messageListProps).not.toContain("typingUsers")
    expect(source).not.toContain('data-onboarding-name={dm.name} className="shrink-0"')
    expect(source).toContain("loading={loadingOwnership.messageBodyLoading}")
    expect(source).not.toContain("<ComposerSkeleton")
    expect(source).not.toContain("<DmHeaderSkeleton")
  })

  it("uses the cache-first DM projection as the header and composer identity", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).toContain("dms.find((candidate) => candidate.id === dmId) ?? null")
    expect(source).not.toContain("profilesByUserId.get(raw.userId)")
  })

  it("owns lazy channel-directory state and retry inside the keyed DM view", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).toContain("return <DmView key={params.dmId} />")
    expect(source).toContain("useChannelRefDirectory(channelRefDirectoryEnabled)")
    expect(source).toContain("loading: !channelRefDirectoryResolved")
    expect(source).toContain("failed: channelRefDirectoryError")
    expect(source).toContain("if (!channelRefDirectoryEnabled)")
    expect(source).toContain("if (channelRefDirectoryError) void refetchChannelRefDirectory()")
    expect(source).toContain("channelRefCandidateSource={channelRefCandidateSource}")
    expect(source).toContain("onChannelRefIntent={handleChannelRefIntent}")
  })

  it("keeps chip toggle and picker add on separate reaction intents", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).toContain("const toggleReaction = useToggleReactionApi()")
    expect(source).toContain("const addReaction = useAddReactionApi()")
    expect(source).toContain("onToggleReaction: (id: string, emoji: string) =>\n      toggleReaction(")
    expect(source).toContain("onReact: (id: string, emoji: string) =>\n      addReaction(")
  })
})
