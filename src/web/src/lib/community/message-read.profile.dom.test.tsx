import { createElement, Profiler } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_VERSION, CommunityMessagesReadSchema, encodeCommunityBrowserEvent, decodeCommunityBrowserEvent } from "@alook/shared"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { resolveMessageTarget } from "@/lib/community/message-door"
import { readCommunityConversationEntry } from "@/lib/community/conversation-entry.server"
import { publishConversationEntry } from "@/lib/community/conversation-entry"
import { planCommittedMessage } from "@/lib/community/message-dispatcher"
import { readCommunityMessageWindow } from "@/lib/community/message-window.server"
import { parseCommunityMessageWindow } from "@/lib/community/messages"
import { decodeCommunityReadResponse } from "@/lib/community/read-response"
import { writeCommunityMessagesRead } from "@/lib/community/read-contract"
import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { captureCommunityLiveSnapshotToken, publishCommunityResourceBundle, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { channelMessagesQueryFn } from "@/lib/community/message-window"
import { useCanonicalMessagesById, useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import { Message } from "@/components/community/messages/message"
const fixtures = vi.hoisted(() => ({ response: null as unknown }))
vi.mock("@/lib/api/client", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api/client")>(), apiFetch: vi.fn(async () => fixtures.response) }))
vi.mock("@/hooks/community/use-inbox", async importOriginal => ({ ...await importOriginal<typeof import("@/hooks/community/use-inbox")>(), useMessageMarked: () => false }))
const stores: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const item of stores) item.sqlite.close(); stores.length = 0 })
it.each(["messages", "entry", "committed-ws"].flatMap(scenario => [false, true].map(softDeleted => ({ scenario, softDeleted }))))("publishes the actual cold author graph before first native consumption ($scenario, soft=$softDeleted)", async ({ scenario, softDeleted }) => {
  const store = createCommunitySqliteDb(); stores.push(store)
  const { sqlite, db } = store
  const stamp = "2026-10-28T00:00:00Z"
  const expectedName = softDeleted ? "Deleted user" : "Former Author"
  const insertUser = sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)')
  for (const [id,name] of [["viewer","Viewer"],["former",expectedName]]) insertUser.run(id, `${id}@example.test`,name,"0001",stamp,stamp)
  if (softDeleted) sqlite.prepare('UPDATE user SET "deletedAt"=? WHERE id=?').run(stamp, "former")
  sqlite.exec("INSERT INTO community_user_profile (user_id,about_me,banner_color,status_emoji,status_text) VALUES ('former','Real about',null,null,null)")
  sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0002','','viewer',?)").run(stamp)
  sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('viewer-member','server','viewer','owner')")
  sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at,creator_id,parent_channel_id,parent_message_id) VALUES ('channel','server','Channel','text','',0,0,1,?,'viewer',null,null)").run(stamp)
  sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at,reply_to_id) VALUES ('message','former','Actual historic message','default','channel',1,?,null)").run(stamp)
  expect(sqlite.prepare("SELECT id FROM community_server_member WHERE server_id='server' AND user_id='former'").get()).toBeUndefined()
  const target = await resolveMessageTarget(db, "viewer", { id: "channel" }, "human")
  if (!target.ok) throw new Error(JSON.stringify(target))
  const result = await readCommunityMessageWindow(db, { viewerId: "viewer", target: target.value, window: parseCommunityMessageWindow(new URLSearchParams()), contract: COMMUNITY_CONTRACT_VERSION })
  if (!result.ok) throw new Error(JSON.stringify(result))
  const response = writeCommunityMessagesRead(new Request("http://localhost/api/community/channels/channel/messages"), "channel", result.page)
  const body = await response.json()
  let wireProfiles = CommunityMessagesReadSchema.parse(body).profiles
  fixtures.response = decodeCommunityReadResponse("/api/community/channels/channel/messages", "GET", response, body)
  const { client, registry } = await createCommunityQueryOwner("viewer")
  const structure = await readCommunityResourceBundle(db, "viewer", { channelIds: ["channel"] })
  await act(async () => { publishCommunityResourceBundle(client, structure, { token: captureCommunityLiveSnapshotToken(client) }) })
  expect(registry.collections.profiles.get("former")).toBeUndefined()
  function Consumer() {
    useCanonicalCommunityProfile("former")
    const rows = useCanonicalMessagesById(["message"])
    const message = rows?.get("message")
    return message ? createElement(Message, { m: { ...message, grouped: false }, onOpenThread: () => {}, viewerUserId: "viewer" }) : createElement("span", { "data-testid": "waiting-message" }, "Waiting")
  }
  const frames: string[] = []
  const container = document.createElement("div")
  document.body.appendChild(container)
  const view = render(createElement(Profiler, { id: "cold-message-author", onRender: () => {
    const name = container.querySelector("[data-message-author-line] button")?.textContent
    if (name) frames.push(name)
  } }, createElement(Consumer)), { container, wrapper: ({ children }) => createElement(CommunityTestProvider, { client, registry, userId: "viewer", retainOwner: true }, children) })
  expect(view.getByTestId("waiting-message")).toBeDefined()
  if (scenario === "messages") {
    await act(async () => { await channelMessagesQueryFn("channel", null, { queryClient: client })({ pageParam: { mode: "newest" } }) })
  } else if (scenario === "entry") {
    const entry = await readCommunityConversationEntry(db, { viewerId: "viewer", target: target.value, window: parseCommunityMessageWindow(new URLSearchParams()), preferTail: true })
    if (!entry.ok) throw new Error(JSON.stringify(entry))
    wireProfiles = entry.entry.profiles
    await act(async () => { publishConversationEntry(client, { serverId: "server", channelId: "channel" }, entry.entry, { token: captureCommunityLiveSnapshotToken(client, "channel") }) })
  } else {
    const plan = await planCommittedMessage(db, "message")
    const encoded = encodeCommunityBrowserEvent(plan.messageEvent)
    if (!encoded.ok) throw new Error(JSON.stringify(encoded))
    const decoded = decodeCommunityBrowserEvent(encoded.envelope)
    if (!decoded.ok) throw new Error(JSON.stringify(decoded))
    wireProfiles = plan.messageEvent.profiles
    await act(async () => { projectCommunityWsEventToDb(client, decoded.event) })
  }
  await waitFor(() => expect(view.container.textContent).toContain("Actual historic message"))
  expect(wireProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: "former", name: expectedName, discriminator: "0001", avatar: null, avatarVersion: 0 })]))
  expect(registry.collections.profiles.get("former")).toMatchObject({ id: "former", name: expectedName, aboutMe: "Real about", bannerColor: null, statusEmoji: null, statusText: null })
  expect(view.container.querySelector("[data-message-author-line]")?.textContent).toContain(expectedName)
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.every(name => name === expectedName)).toBe(true)
})

it.each(["initial", "two-hop"])("carries the actual SQL approval author through strict encoding and first native consumption (%s)", async scenario => {
  const { queries } = await import("@alook/shared")
  const store = createCommunitySqliteDb(); stores.push(store)
  const { sqlite, db } = store
  const stamp = "2026-10-28T00:00:00Z"
  const insert = sqlite.prepare('INSERT INTO user (id,email,name,discriminator,image,"avatarVersion","createdAt","updatedAt","isBot","ownerUserId") VALUES (?,?,?,?,?,?,?,?,?,?)')
  for (const [id, name, bot, owner, version] of [["human1","Human",0,null,0],["owner1","Owner One",0,null,0],["owner2","Owner Two",0,null,0],["bot1","First Bot",1,"owner1",7],["bot2","Second Bot",1,"owner2",9]] as const) insert.run(id, `${id}@example.test`, name, "0042", null, version, stamp, stamp, bot, owner)
  sqlite.exec("INSERT INTO community_user_profile (user_id,about_me,status_emoji,status_text) VALUES ('bot1','First real about',null,null),('bot2','Second real about',null,null)")
  const request = await queries.communityFriendship.sendRequest(db, { requesterId: scenario === "initial" ? "human1" : "bot1", addresseeId: scenario === "initial" ? "bot1" : "bot2" })
  const result = scenario === "initial" ? request : await queries.communityFriendship.ownerDecideOnRow(db, { friendshipId: request.friendship.id, actorId: "owner1", decision: "approve" })
  if ("ok" in result && !result.ok) throw new Error(result.reason)
  const viewer = scenario === "initial" ? "owner1" : "owner2"
  const author = scenario === "initial" ? "bot1" : "bot2"
  const expectedName = scenario === "initial" ? "First Bot" : "Second Bot"
  const creates = result.broadcasts.filter(broadcast => broadcast.event.type === "community:message.create")
  expect(creates).toHaveLength(1)
  expect(creates[0].userId).toBe(viewer)
  const encoded = encodeCommunityBrowserEvent(creates[0].event)
  if (!encoded.ok) throw new Error(JSON.stringify(encoded))
  const decoded = decodeCommunityBrowserEvent(encoded.envelope)
  if (!decoded.ok || decoded.event.type !== "community:message.create") throw new Error(JSON.stringify(decoded))
  const event = decoded.event
  expect(event.message.authorId).toBe(author)
  expect(event.message.approval).toMatchObject({ friendshipId: request.friendship.id, status: "pending", waitingOn: "you", botProfile: { id: author, name: expectedName, discriminator: "0042", image: null, avatarVersion: scenario === "initial" ? 7 : 9 } })
  expect(event.message.content).toContain(expectedName)
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_message").get()).toMatchObject({ count: scenario === "initial" ? 1 : 2 })
  expect(sqlite.prepare("SELECT status,needs_owner_approval AS owner FROM community_friendship WHERE id=?").get(request.friendship.id)).toMatchObject({ status: "pending", owner: viewer })
  const { client, registry } = await createCommunityQueryOwner(viewer)
  const structure = await readCommunityResourceBundle(db, viewer, { channelIds: [event.channelId] })
  publishCommunityResourceBundle(client, structure, { token: captureCommunityLiveSnapshotToken(client) })
  expect(registry.collections.profiles.get(author)).toBeUndefined()
  function Consumer() {
    useCanonicalCommunityProfile(author)
    const rows = useCanonicalMessagesById([event.message.id])
    const message = rows?.get(event.message.id)
    return message ? createElement(Message, { m: { ...message, grouped: false }, onOpenThread: () => {}, viewerUserId: viewer }) : createElement("span", null, "Waiting")
  }
  const frames: string[] = []
  const container = document.createElement("div"); document.body.appendChild(container)
  const view = render(createElement(Profiler, { id: "approval-author", onRender: () => {
    const name = container.querySelector("[data-message-author-line] button")?.textContent
    if (name) frames.push(name)
  } }, createElement(Consumer)), { container, wrapper: ({ children }) => createElement(CommunityTestProvider, { client, registry, userId: viewer, retainOwner: true }, children) })
  await act(async () => { projectCommunityWsEventToDb(client, event) })
  await waitFor(() => expect(view.container.querySelector("[data-message-author-line]")?.textContent).toContain(expectedName))
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.every(name => name === expectedName)).toBe(true)
  expect(registry.collections.profiles.get(author)).toMatchObject({ name: expectedName, discriminator: "0042", avatar: null, avatarVersion: scenario === "initial" ? 7 : 9, aboutMe: scenario === "initial" ? "First real about" : "Second real about", statusEmoji: null, statusText: null })
})

it.each([false, true])("keeps current actual DB profile facts on first native consumption of a retained old create (warm=%s)", async warm => {
  const { queries } = await import("@alook/shared")
  const store = createCommunitySqliteDb(); stores.push(store)
  const { sqlite, db } = store
  const stamp = "2026-10-28T00:00:00Z"
  const insert = sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)')
  insert.run("viewer", "viewer@example.test", "Viewer", "0042", stamp, stamp)
  insert.run("former", "former@example.test", "Before", "0043", stamp, stamp)
  sqlite.exec("INSERT INTO community_user_profile (user_id,about_me,banner_color,status_emoji,status_text) VALUES ('former','Before about',null,'old','Before status')")
  sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0044','','viewer',?)").run(stamp)
  sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('member','server','viewer','owner')")
  sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at,creator_id,parent_channel_id,parent_message_id) VALUES ('channel','server','Channel','text','',0,0,1,?,'viewer',null,null)").run(stamp)
  sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at,reply_to_id) VALUES ('retained','former','Retained message','default','channel',1,?,null)").run(stamp)
  const plan = await planCommittedMessage(db, "retained")
  const encoded = encodeCommunityBrowserEvent(plan.messageEvent)
  if (!encoded.ok) throw new Error(JSON.stringify(encoded))
  const { client, registry } = await createCommunityQueryOwner("viewer")
  const structure = await readCommunityResourceBundle(db, "viewer", { channelIds: ["channel"], ...(warm ? { profileIds: ["former"] } : {}) })
  publishCommunityResourceBundle(client, structure, { token: captureCommunityLiveSnapshotToken(client) })
  const frames: string[] = []
  function Consumer() {
    useCanonicalCommunityProfile("former")
    const message = useCanonicalMessagesById(["retained"])?.get("retained")
    return message ? createElement(Message, { m: { ...message, grouped: false }, onOpenThread: () => {}, viewerUserId: "viewer" }) : createElement("span", null, "Waiting")
  }
  const container = document.createElement("div"); document.body.appendChild(container)
  const view = render(createElement(Profiler, { id: "retained-author", onRender: () => {
    const name = container.querySelector("[data-message-author-line] button")?.textContent
    if (name) frames.push(name)
  } }, createElement(Consumer)), { container, wrapper: ({ children }) => createElement(CommunityTestProvider, { client, registry, userId: "viewer", retainOwner: true }, children) })
  sqlite.exec("UPDATE user SET name='After',avatarVersion=2 WHERE id='former'; UPDATE community_user_profile SET about_me='After about',banner_color='blue',status_emoji=null,status_text=null WHERE user_id='former'")
  const [fresh] = await queries.communityUserProfile.getResourceProfiles(db, ["former"])
  if (!fresh || fresh.aboutMe === undefined || fresh.bannerColor === undefined || fresh.statusEmoji === undefined || fresh.statusText === undefined) throw new Error("Actual DB profile facts missing")
  await act(async () => {
    projectCommunityWsEventToDb(client, { type: "community:profile.update", userId: fresh.id, name: fresh.name, discriminator: fresh.discriminator, aboutMe: fresh.aboutMe!, bannerColor: fresh.bannerColor!, kind: "human", ownerUserId: null })
    if (!warm) expect(registry.collections.profiles.has("former")).toBe(false)
    projectCommunityWsEventToDb(client, { type: "community:status.update", userId: fresh.id, statusEmoji: fresh.statusEmoji!, statusText: fresh.statusText! })
    if (!warm) expect(registry.collections.profiles.has("former")).toBe(false)
    projectCommunityWsEventToDb(client, { type: "community:identity.update", userId: fresh.id, avatar: fresh.avatar, avatarVersion: fresh.avatarVersion })
  })
  const decoded = decodeCommunityBrowserEvent(encoded.envelope)
  if (!decoded.ok) throw new Error(JSON.stringify(decoded))
  await act(async () => { for (let delivery = 0; delivery < 3; delivery++) projectCommunityWsEventToDb(client, decoded.event) })
  await waitFor(() => expect(view.container.querySelector("[data-message-author-line]")?.textContent).toContain("After"))
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.every(name => name === "After")).toBe(true)
  expect(registry.collections.profiles.get("former")).toMatchObject(fresh)
  expect(registry.collections.messages.get("retained")?.authorName).toBe("Before")
})
