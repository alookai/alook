import { createElement } from "react"
import { afterEach, expect, it } from "vitest"
import { queries } from "@alook/shared"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { act, mockElementGeometry, render } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { readCommunityThreadsResource } from "./thread-read"
import { readCommunityResourceBundle } from "./attention-resources.server"
import { captureCommunityLiveSnapshotToken, publishCommunityForumFeed, publishCommunityResourceBundle } from "@/lib/community-db/sync"
import { useCanonicalChannelsById, useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { forumFeedWindow, normalizeThreadResources } from "@/hooks/community/forum-feed-window"
import { mapForumFeedPages } from "@/hooks/community/use-forum-feed"
import { ForumView } from "@/components/community/channels/forum-view"
import { tid } from "@/lib/community/testids"

const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const item of fixtures) item.sqlite.close(); fixtures.length = 0 })

it.each(["same-channel", "foreign-channel"])("renders the real cold post author after notify exit with %s reply", async scenario => {
  const fixture = createCommunitySqliteDb()
  fixtures.push(fixture)
  const { sqlite, db } = fixture
  const stamp = "2026-10-28T00:00:00Z"
  const insertUser = sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)')
  for (const [id, name] of [["viewer", "Viewer"], ["author", "Former Author"], ["reply-author", "Reply Author"]]) insertUser.run(id, `${id}@example.test`, name, "0001", stamp, stamp)
  sqlite.exec("INSERT INTO community_user_profile (user_id,about_me,banner_color,status_emoji,status_text) VALUES ('author','Real about','#123456','🌿','Real status')")
  sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0002','','viewer',?)").run(stamp)
  sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('viewer-member','server','viewer','owner'),('author-member','server','author','member')")
  const insertChannel = sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at,creator_id,parent_channel_id,parent_message_id) VALUES (?,'server',?,?,'',0,0,1,?,?,?,?)")
  insertChannel.run("forum", "Forum", "forum", stamp, "viewer", null, null)
  insertChannel.run("post", "Post", "thread", stamp, "author", "forum", "opener")
  const insertMessage = sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at,reply_to_id) VALUES (?,?,?,'default',?,?,?,?)")
  insertMessage.run("opener", "author", "Actual post title", "forum", 1, stamp, null)
  insertMessage.run("first", "author", "Actual post body", "post", 2, stamp, "previous")
  insertMessage.run("previous", "reply-author", "Previous reply", scenario === "same-channel" ? "post" : "foreign-thread", 1, stamp, null)
  sqlite.exec("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES ('viewer-notify','post','viewer','notify','added')")
  const parent = await queries.communityChannel.getChannel(db, "forum")
  const children = await queries.communityChannel.getChannelsByIds(db, ["post"])
  const messages = await queries.communityMessage.getMessagesByIdsInChannels(db, ["opener", "first"], ["forum", "post"])
  const participants = await queries.communityThread.listParticipantsForChannels(db, ["post"])
  expect(participants.some(row => row.userId === "author")).toBe(false)
  const resource = await readCommunityThreadsResource(db, "viewer", parent, children, { messages, participants, tags: [] })
  const page = normalizeThreadResources("forum", resource)
  const window = forumFeedWindow(page)
  const { client, registry } = await createCommunityQueryOwner("viewer")
  expect(registry.collections.profiles.get("author")).toBeUndefined()
  expect(registry.collections.friendships.size).toBe(0)
  const structure = await readCommunityResourceBundle(db, "viewer", { channelIds: ["forum", "post"] })
  await act(async () => {
    publishCommunityResourceBundle(client, structure, { token: captureCommunityLiveSnapshotToken(client) })
    publishCommunityForumFeed(client, "forum", page, { token: captureCommunityLiveSnapshotToken(client) })
  })
  function Harness() {
    const channels = useCanonicalChannelsById()
    const messages = useCanonicalMessagesById(["opener", "first"])
    const profiles = useCanonicalProfilesByUserId()
    const posts = mapForumFeedPages([window], messages ?? new Map(), channels, profiles)
    return createElement(ForumView, { forumChannelId: "forum", posts, members: [], tag: "All", hasMore: false,
      onTagChange: () => {}, onOpenPost: () => {}, onLoadMore: () => {},
      onScrollRoot: root => { if (root) mockElementGeometry(root, { clientHeight: 600, clientWidth: 800, scrollHeight: 600 }) },
    })
  }
  const view = render(createElement(Harness), { wrapper: ({ children }) => createElement(CommunityTestProvider, { client, userId: "viewer", retainOwner: true }, children) })
  const card = await view.findByTestId(tid.forumThreadCard("post"))
  expect(card.textContent).toContain("Actual post title")
  console.info(JSON.stringify({ case: "actual-thread-read-publish-forum-cold", participantIds: participants.map(row => row.userId), includedProfileIds: resource.included.profiles.map(row => row.id), rendered: card.textContent }))
  expect(card.textContent).toContain("Former Author")
  expect(registry.collections.profiles.get("author")).toMatchObject({ id: "author", name: "Former Author", discriminator: "0001", avatar: null, avatarVersion: 0, aboutMe: "Real about", bannerColor: "#123456", statusEmoji: "🌿", statusText: "Real status" })
  if (scenario === "same-channel") expect(registry.collections.profiles.get("reply-author")).toMatchObject({ id: "reply-author", name: "Reply Author" })
  else expect(registry.collections.profiles.get("reply-author")).toBeUndefined()
})
