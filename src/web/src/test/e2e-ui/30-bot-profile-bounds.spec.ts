import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, attachPageScreenshot, enrollBot, sendBotMessage, openBotProfile, probeOwnedBotProfile } from "./_fixtures/bot-profile-audit"

test("owned bot profile preview stays root-bounded from its first visible frame", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser } = actors
  const { seedChannel, seedForumThread, seedJoinServer, seedServer } = actors.seed
  const { jsonRequest, pairMachine, createBot, joinBotToServer, headersFor } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `preview-overflow-${suffix}`)
  const channelName = `regular-${suffix}`
  const forumName = `forum-${suffix}`
  const channelId = await seedChannel("alice", serverId, channelName)
  const forumId = await seedChannel("alice", serverId, forumName, "forum")
  const forumThreadId = await seedForumThread(
    "alice",
    forumId,
    `Right column ${suffix}`,
    `Forum opener ${suffix}`,
  )
  await seedJoinServer("alice", "bob", serverId)

  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
  await machine.opened
  const botName = `Overflow bot ${suffix}`
  const botId = await createBot(machineId, botName)
  const runnerKey = await enrollBot(credential, botId)
  await joinBotToServer(runnerKey, botId, serverId)
  const { servers } = await jsonRequest<{
    servers: Array<{ id: string; name: string; discriminator: string }>
  }>("alice", "/api/community/servers")
  const server = servers.find((candidate) => candidate.id === serverId)
  expect(server).toBeTruthy()
  const channelRef = `/${server!.name}#${server!.discriminator}/${channelName}`
  const forumRef = `/${server!.name}#${server!.discriminator}/${forumName}`
  const forumEnvelope = await jsonRequest<{
    threads: Array<{ id: string; parentMessageId: string | null }>
    included: { messages: Array<{ id: string; seq: number }> }
  }>(
    "alice",
    `/api/community/channels/${forumId}/threads?order=createdAt&limit=50&include=parentMessage`,
  )
  const forumThread = forumEnvelope.threads.find((thread) => thread.id === forumThreadId)
  const forumOpener = forumEnvelope.included.messages.find(
    (message) => message.id === forumThread?.parentMessageId,
  )
  expect(forumOpener?.seq).toBeGreaterThan(0)
  await sendBotMessage(runnerKey, channelRef, `Regular overflow probe ${suffix}`)
  await sendBotMessage(
    runnerKey,
    `${forumRef}/#${forumOpener!.seq}`,
    `Forum overflow probe ${suffix}`,
  )

  const regularRoute = `/c/channels/${serverId}/${channelId}`
  const alice = await asUser("alice")
  await alice.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(alice.page, regularRoute)
  const regularFrames = await probeOwnedBotProfile(
    alice.page,
    alice.page.getByRole("button", { name: botName, exact: true }),
    "regular channel",
  )
  await testInfo.attach("owned-agent-preview-regular-frames.json", {
    body: Buffer.from(JSON.stringify(regularFrames, null, 2)),
    contentType: "application/json",
  })
  await attachPageScreenshot(testInfo, "owned-agent-preview-regular", alice.page)

  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${forumThreadId}`)
  const split = alice.page.getByTestId(tid.threadSplit)
  await expect(split).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
  const threadPanel = alice.page.getByTestId(tid.threadSplitPanel)
  const forumFrames = await probeOwnedBotProfile(
    alice.page,
    threadPanel.getByRole("button", { name: botName, exact: true }),
    "forum split right column",
  )
  await testInfo.attach("owned-agent-preview-forum-split-frames.json", {
    body: Buffer.from(JSON.stringify(forumFrames, null, 2)),
    contentType: "application/json",
  })
  await attachPageScreenshot(testInfo, "owned-agent-preview-forum-split", alice.page)

  await alice.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(alice.page, regularRoute)
  await openBotProfile(alice.page, botName)
  await expect(alice.page.getByRole("dialog", { name: `${botName} profile` })).toBeVisible()
  await expect(alice.page.getByTestId(tid.botMarkSticker)).toBeVisible()
  await expect(alice.page.getByTestId(tid.botAuditPreviewDock)).toHaveCount(0)
  await attachPageScreenshot(testInfo, "owned-agent-preview-mobile-390", alice.page)

  const bob = await asUser("bob")
  await bob.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(bob.page, regularRoute)
  await openBotProfile(bob.page, botName)
  await expect(bob.page.getByTestId(tid.profileOwnerLink)).toBeVisible()
  await expect(bob.page.getByTestId(tid.botMarkSticker)).toHaveCount(0)
  await expect(bob.page.getByTestId(tid.botAuditPreviewDock)).toHaveCount(0)
  await attachPageScreenshot(testInfo, "owned-agent-preview-non-owner", bob.page)
})
