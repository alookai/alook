import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("DM page loading ownership", () => {
  it("keeps full-frame and message-body ownership separate", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).toContain("fullFramePending: !hasDm && dmsLoading")
    expect(source).toContain("notFound: !hasDm && !dmsLoading")
    expect(source).toContain("messageBodyLoading: hasDm && (")
    expect(source).toContain("readSnapshotFetching ||\n      messagesLoading")
    expect(source).toContain("if (loadingOwnership.fullFramePending)")
    expect(source).toContain("<DmHeader\n")
    expect(source).toContain("<Composer\n")
    expect(source).toContain("loading={loadingOwnership.messageBodyLoading}")
    expect(source).not.toContain("<ComposerSkeleton")
    expect(source).not.toContain("<DmHeaderSkeleton")
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
})
