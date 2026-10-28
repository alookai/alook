import { currentCommunityFixtureError } from "./_fixtures/business-contract"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_BOT_ACTOR_HEADER, COMMUNITY_CONTRACT_HEADER, WS_EVENTS, admitCommunityBrowserEventBatch, decodeCommunityBrowserEvent, isCommunityBrowserEventBatchCandidate, type CommunityWsEvent } from "@alook/shared"
import { spawnSync } from "node:child_process"
import type { Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import type { CaseActors, CaseResources } from "./_fixtures/case-fixture"
import { connectMachine } from "./_fixtures/community-machine"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { REPO_ROOT, WEB_URL } from "./_setup/paths"

type Bot = { id: string; name: string; runnerKey: string }
type MembershipEvent = Extract<CommunityWsEvent, { type: typeof WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE | typeof WS_EVENTS.MEMBER_LEAVE }>

async function prepareMembershipCase(actors: CaseActors, resources: CaseResources) {
  const headers = (role: "alice" | "bob" = "alice") => ({ Cookie: actors.sessionCookie(role), Origin: WEB_URL, "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) })
  const call = (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(`${WEB_URL}${path}`, {method, headers:{...headers(),...extra}, ...(body === undefined ? {} : {body:JSON.stringify(body)})})
  const pair = await call("/api/community/machines/pair", "POST")
  expect(pair.status).toBe(200)
  const { tokenId } = await pair.json() as { tokenId: string }
  const activation = await fetch(`${WEB_URL}/api/community/daemon/activate`, {method:"POST",headers:{Authorization:`Bearer ${tokenId}`,Origin:WEB_URL,"Content-Type":"application/json"},body:JSON.stringify({hostname:`membership-qa-${Date.now()}`,platform:"darwin",arch:"arm64",runtimeReport:[{id:"codex",status:"healthy"}]})})
  expect(activation.status).toBe(200)
  const {machineId,credential} = await activation.json() as {machineId:string;credential:string}
  resources.own(machineId, async id => {expect([204,404]).toContain((await call(`/api/community/machines/${id}`,"DELETE")).status)})
  const machine = connectMachine(credential,resources,{machineId,headers:headers()})
  await machine.opened
  const bots: Bot[] = []
  for (const name of ["Research companion", "Release assistant"]) {
    const response = await call("/api/community/bots","POST",{name,machineId,runtime:"codex"})
    expect(response.status).toBe(201)
    const {bot} = await response.json() as {bot:{id:string;name:string}}
    resources.own(bot.id,async id => {expect([204,404]).toContain((await call(`/api/community/bots/${id}`,"DELETE")).status)})
    const enroll = await call("/api/community/daemon/enroll-agent","POST",{agentId:bot.id},{Authorization:`Bearer ${credential}`})
    expect(enroll.status).toBe(200)
    const {runnerKey} = await enroll.json() as {runnerKey:string}
    bots.push({...bot,runnerKey})
  }
  const [first,second] = bots as [Bot,Bot]
  const servers: Array<{id:string;handle:string;publicId:string;privateId:string;privateRef:string;hiddenId:string;threadId:string;messageId:string}> = []
  for (const name of ["Membership studio", "Release planning with a deliberately long server name"]) {
    const id = await actors.seed.seedServer("alice",name)
    const token = await actors.seed.createInvite("alice",id)
    let handle = ""
    for (const bot of bots) {
      const joined = await call(`/api/community/invites/${token}/join`,"POST",{},{Authorization:`Bearer ${bot.runnerKey}`})
      expect(joined.status).toBe(200)
      const {server} = await joined.json() as {server:{name:string;discriminator:string}}
      handle=`${server.name}#${server.discriminator}`
    }
    const publicId = await actors.seed.seedChannel("alice",id,"announcements","text")
    await actors.seed.seedChannel("alice",id,"ideas-and-feedback","forum")
    const categoryId = await actors.seed.seedCategory("alice",id,"Do not show this category",{private:true})
    const privateId = await actors.seed.seedChannel("alice",id,"private-working-notes","text",categoryId)
    const hiddenId = await actors.seed.seedChannel("alice",id,"hidden-from-bots","text",categoryId)
    for (const bot of bots) expect((await call(`/api/community/channels/${privateId}/members`,"POST",{userId:bot.id})).status).toBe(201)
    const messageId = await actors.seed.seedMessage("alice",privateId,"Preserved history before bot exit")
    const threadId = await actors.seed.seedThread("alice",messageId,"Child participation")
    for (const bot of bots) expect((await call(`/api/community/channels/${threadId}/participants`,"POST",{userId:bot.id})).status).toBe(201)
    servers.push({id,handle,publicId,privateId,privateRef:`/${handle}/private-working-notes`,hiddenId,threadId,messageId})
  }
  return {headers,call,bots,first,second,servers,machine}
}

async function openMemberships(page: Page, bot: Bot) {
  const card = page.locator('[data-slot="card"]').filter({has:page.getByText(bot.name,{exact:true})})
  await expect(card).toHaveCount(1)
  const trigger = card.getByRole("button",{name:"Bot actions",exact:true})
  await trigger.click()
  await page.getByTestId(tid.botMembershipsMenu(bot.id)).click()
  await expect(page.getByTestId(tid.botMembershipsSheet)).toBeVisible()
  const description = page.getByTestId(tid.botMembershipsSheet).locator('[data-slot="sheet-description"]')
  await expect(description).toContainText(bot.name)
  const avatar = description.locator("svg")
  await expect(avatar).toHaveCount(1)
  expect(await avatar.innerHTML()).toBe(await card.locator("svg").first().innerHTML())
  expect((await avatar.boundingBox())!.width).toBe(24)
  expect((await avatar.boundingBox())!.height).toBe(24)
  await expect(page.getByRole("menu",{includeHidden:true})).toHaveCount(0)
  return trigger
}

function observeMembershipEvents(page: Page) {
  const events: MembershipEvent[] = []
  page.on("websocket", socket => socket.on("framereceived", async ({payload}) => {
    const text = String(payload)
    if (!text.startsWith("{")) return
    const frame: unknown = JSON.parse(text)
    const admitted = isCommunityBrowserEventBatchCandidate(frame)
      ? await admitCommunityBrowserEventBatch(frame)
      : decodeCommunityBrowserEvent(frame)
    if (!admitted.ok) return
    for (const item of "events" in admitted ? admitted.events : [admitted.event]) {
      if (item.type === WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE || item.type === WS_EVENTS.MEMBER_LEAVE) events.push(item)
    }
  }))
  return events
}

function membershipRows(serverId: string, botIds: string[]) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const sql = `SELECT m.user_id AS userId, m.channel_id AS channelId, m.relation FROM community_channel_member m JOIN community_channel c ON c.id=m.channel_id WHERE c.server_id=${quote(serverId)} AND m.user_id IN (${botIds.map(quote).join(",")}) ORDER BY m.user_id,m.channel_id,m.relation`
  const result = spawnSync("pnpm", ["exec","wrangler","d1","execute","alook-app","--local","--json","--command",sql],{cwd:`${REPO_ROOT}/src/web`,encoding:"utf8",maxBuffer:4*1024*1024})
  expect(result.status).toBe(0)
  return (JSON.parse(result.stdout) as Array<{results:Array<{userId:string;channelId:string;relation:string}>}>)[0]!.results
}

test("owned bot exits preserve other identities, child participation boundaries and history", async ({caseActors,caseResources},testInfo) => {
  test.setTimeout(180_000)
  const actors = await caseActors(["alice","bob"])
  const fixture = await prepareMembershipCase(actors,caseResources)
  const {first,second,servers,call,headers} = fixture
  const [studio,release] = servers
  const actorHeader = {[COMMUNITY_BOT_ACTOR_HEADER]:first.id}
  const list = await call("/api/community/servers/channels","GET",undefined,actorHeader)
  expect(list.status).toBe(200)
  const body = await list.json() as {servers:Array<{id:string;handle:string}>;groups:Array<{channels:Array<{ref:string;name:string}>}>}
  expect(body.servers.map(s=>s.id).sort()).toEqual(servers.map(s=>s.id).sort())
  const channels = body.groups.flatMap(g=>g.channels)
  expect(channels.some(c=>c.ref===studio.privateRef)).toBe(true)
  expect(channels.some(c=>c.name==="hidden-from-bots")).toBe(false)
  expect(channels.some(c=>c.name==="Child participation")).toBe(false)
  expect((await fetch(`${WEB_URL}/api/community/servers/channels`,{headers:{...headers("bob"),...actorHeader}})).status).toBe(404)
  expect((await call("/api/community/servers/channels","GET",undefined,{...actorHeader,Authorization:`Bearer ${first.runnerKey}`})).status).toBe(403)
  expect((await call("/api/community/users/me/notifications","GET",undefined,actorHeader)).status).toBe(403)
  const publicLeave = `/api/community/channels/resolve/members/self?ref=${encodeURIComponent(`/${studio.handle}/announcements`)}`
  expect((await call(publicLeave,"DELETE",undefined,actorHeader)).status).toBe(400)
  expect((await call(`/api/community/channels/${studio.privateId}/members/${second.id}`,"DELETE",undefined,actorHeader)).status).toBe(403)
  const before = membershipRows(studio.id,[first.id,second.id])
  expect(before.filter(r=>r.userId===first.id).map(r=>r.relation).sort()).toEqual(["access","notify"])
  const {page} = await actors.asUser("alice",{viewport:{width:1280,height:900},reducedMotion:"reduce"})
  const events = observeMembershipEvents(page)
  await gotoAfterUserWsAuth(page,"/c/me/bots")
  const trigger = await openMemberships(page,first)
  const sheet = page.getByTestId(tid.botMembershipsSheet)
  await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toBeVisible()
  await expect(sheet.getByText("Do not show this category",{exact:true})).toHaveCount(0)
  await expect(sheet.getByText("hidden-from-bots",{exact:true})).toHaveCount(0)
  await expect(sheet.getByTestId(tid.botMembershipsLeave(`/${studio.handle}/announcements`))).toBeEnabled()
  await page.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
  await expect(page.getByRole("alertdialog")).toContainText(first.name)
  await expect(page.getByRole("alertdialog")).toContainText("Membership-studio")
  await page.getByRole("button",{name:"Cancel",exact:true}).click()
  expect(membershipRows(studio.id,[first.id,second.id])).toEqual(before)
  let fail = true
  let requests = 0
  let releaseResponse!: () => void
  const gate = new Promise<void>(r=>releaseResponse=r)
  caseResources.own(releaseResponse,async r=>r())
  let captured!: () => void
  const saved = new Promise<void>(r=>captured=r)
  const leavePath = `/api/community/channels/resolve/members/self?ref=${encodeURIComponent(studio.privateRef)}`
  await page.route(`**${leavePath}`,async route=>{
    requests++
    expect(route.request().headers()[COMMUNITY_BOT_ACTOR_HEADER.toLowerCase()]).toBe(first.id)
    expect(route.request().headers().authorization).toBeUndefined()
    if(fail){await route.fulfill(currentCommunityFixtureError("QA temporary failure",503));return}
    const response = await route.fetch()
    expect(response.status()).toBe(204)
    captured()
    await gate
    await route.fulfill({response})
  })
  await page.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
  const confirm = page.getByTestId(tid.botMembershipsConfirm)
  await confirm.click()
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("QA temporary failure")
  expect(membershipRows(studio.id,[first.id,second.id])).toEqual(before)
  fail=false
  await confirm.click()
  await saved
  await expect(confirm).toBeDisabled()
  await expect(page.getByRole("button",{name:"Cancel",exact:true})).toBeDisabled()
  await confirm.dispatchEvent("click")
  expect(requests).toBe(2)
  releaseResponse()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toHaveCount(0)
  const after = membershipRows(studio.id,[first.id,second.id])
  expect(after).toEqual(before.filter(r=>r.userId===second.id))
  await testInfo.attach("received-community-events",{body:JSON.stringify(events),contentType:"application/json"})
  await expect.poll(()=>events.some(e=>e.type===WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE&&e.userId===first.id&&e.channelId===studio.privateId&&e.relation==="access"&&e.present===false)).toBe(true)
  expect((await call(leavePath,"DELETE",undefined,actorHeader)).status).toBe(403)
  expect((await call(`/api/community/bots/${first.id}/active`,"PATCH",{active:false})).status).toBe(200)
  expect((await call("/api/community/servers/channels","GET",undefined,actorHeader)).status).toBe(200)
  expect((await call("/api/community/channels/resolve/messages","POST",{channel:`/${release.handle}/announcements`,content:{text:"must not send"}},actorHeader)).status).toBe(403)
  await page.getByTestId(tid.botMembershipsLeave(`/${release.handle}/announcements`)).click()
  await expect(page.getByRole("alertdialog")).toContainText("public")
  await expect(confirm).toHaveText("Leave server")
  const left = page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/api/community/servers/resolve/leave")
  await confirm.click()
  expect((await left).status()).toBe(204)
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
  expect(membershipRows(release.id,[first.id,second.id]).map(r=>r.userId)).toEqual([second.id,second.id])
  await expect.poll(()=>events.some(e=>e.type===WS_EVENTS.MEMBER_LEAVE&&e.userId===first.id&&e.serverId===release.id)).toBe(true)
  const roster = await call(`/api/community/servers/${release.id}/members`)
  expect(roster.status).toBe(200)
  const members = (await roster.json() as {members:Array<{userId:string}>}).members.map(m=>m.userId)
  expect(members).toContain(actors.userId("alice"))
  expect(members).toContain(second.id)
  expect(members).not.toContain(first.id)
  const history = await call(`/api/community/channels/${release.privateId}/messages`)
  expect(history.status).toBe(200)
  expect((await history.json() as {messages:Array<{id:string}>}).messages.some(m=>m.id===release.messageId)).toBe(true)
  await page.getByTestId(tid.botMembershipsLeave(studio.id)).click()
  await confirm.click()
  await expect(sheet.getByText("No servers yet",{exact:true})).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await openMemberships(page,second)
  for(const server of servers) await expect(page.getByTestId(tid.botMembershipsServer(server.id))).toBeVisible()
  await testInfo.attach("membership-api-d1-ws",{body:JSON.stringify({before,after,events,protectedIdentities:[actors.userId("alice"),second.id],historyPreserved:release.messageId}),contentType:"application/json"})
})

test("membership loading and late responses stay bound to the selected bot on desktop and mobile", async ({caseActors,caseResources},testInfo) => {
  test.setTimeout(180_000)
  const actors = await caseActors(["alice"])
  const {first,second,servers,call} = await prepareMembershipCase(actors,caseResources)
  const [studio,release] = servers
  expect((await call(`/api/community/servers/resolve/leave?server=${encodeURIComponent(release.handle)}`,"POST",undefined,{[COMMUNITY_BOT_ACTOR_HEADER]:second.id})).status).toBe(204)
  const {page} = await actors.asUser("alice",{viewport:{width:1440,height:1000},reducedMotion:"reduce"})
  await gotoAfterUserWsAuth(page,"/c/me/bots")
  const style="nextjs-portal, .tsqd-open-btn-container { visibility:hidden !important; }"
  const botCard = page.locator('[data-slot="card"]').filter({has:page.getByText(first.name,{exact:true})})
  await expect(botCard).toHaveCount(1)
  await botCard.getByRole("button",{name:"Bot actions",exact:true}).click()
  await expect(page.getByRole("menuitem",{name:"Restart",exact:true})).toBeVisible()
  await expect(page.getByRole("menuitem",{name:"Reset",exact:true})).toHaveCount(0)
  await page.screenshot({path:testInfo.outputPath("bot-restart-menu.png"),style})
  await page.getByRole("menuitem",{name:"Restart",exact:true}).click()
  await expect(page.getByRole("alertdialog").getByRole("heading",{name:"Restart this bot?",exact:true})).toBeVisible()
  await expect(page.getByRole("menu",{includeHidden:true})).toHaveCount(0)
  await page.screenshot({path:testInfo.outputPath("bot-restart-confirm.png"),style})
  await page.getByRole("alertdialog").getByRole("button",{name:"Cancel",exact:true}).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  let releaseFailure!: () => void
  const failureGate = new Promise<void>(r=>releaseFailure=r)
  caseResources.own(releaseFailure,async r=>r())
  let fail = true
  let hold = false
  let releaseRead!: () => void
  let captureRead!: () => void
  let finishRead!: () => void
  const gate = new Promise<void>(r=>releaseRead=r)
  const captured = new Promise<void>(r=>captureRead=r)
  const delivered = new Promise<void>(r=>finishRead=r)
  caseResources.own(releaseRead,async r=>r())
  await page.route("**/api/community/servers/channels",async route=>{
    if(route.request().headers()[COMMUNITY_BOT_ACTOR_HEADER.toLowerCase()]!==first.id){await route.continue();return}
    if(fail){await failureGate;await route.fulfill(currentCommunityFixtureError("QA loading unavailable",503));return}
    if(!hold){await route.continue();return}
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    captureRead()
    await gate
    await route.fulfill({response}).catch(()=>undefined)
    finishRead()
  })
  const sheet = page.getByTestId(tid.botMembershipsSheet)
  await openMemberships(page,first)
  await expect(sheet.getByLabel("Loading servers and channels")).toBeVisible()
  await page.screenshot({path:testInfo.outputPath("memberships-loading.png"),style})
  releaseFailure()
  await expect(sheet.getByRole("alert")).toHaveText("Could not load servers and channels.")
  fail=false
  await sheet.getByRole("button",{name:"Try again",exact:true}).click()
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  hold=true
  await openMemberships(page,first)
  await captured
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await openMemberships(page,second)
  await expect(sheet.getByTestId(tid.botMembershipsServer(studio.id))).toBeVisible()
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
  releaseRead()
  await delivered
  await expect(sheet).toContainText(second.name)
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
  hold=false
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await openMemberships(page,first)
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
  await page.screenshot({path:testInfo.outputPath("memberships-desktop-light.png"),style})
  await page.keyboard.press("Escape")
  await page.getByTestId(tid.userSettingsOpen).click()
  await page.getByTestId(tid.settingsTab("appearance")).click()
  await page.getByRole("button",{name:"Dark",exact:true}).click()
  await expect(page.getByRole("button",{name:"Dark",exact:true})).toHaveAttribute("aria-pressed","true")
  await page.getByTestId(tid.settingsClose).click()
  await openMemberships(page,first)
  await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
  await page.screenshot({path:testInfo.outputPath("memberships-desktop-dark.png"),style})
  await page.keyboard.press("Escape")
  await page.getByTestId(tid.userSettingsOpen).click()
  await page.getByTestId(tid.settingsTab("appearance")).click()
  await page.getByRole("button",{name:"Light",exact:true}).click()
  await page.getByTestId(tid.settingsClose).click()
  await page.setViewportSize({width:390,height:844})
  await openMemberships(page,first)
  await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toBeVisible()
  const box = (await sheet.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x+box.width).toBeLessThanOrEqual(390)
  expect((await sheet.getByTestId(tid.botMembershipsLeave(studio.privateRef)).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  const actions = sheet.getByTestId(/^bot-memberships-leave-/)
  expect(await actions.count()).toBeGreaterThan(2)
  const privateRow = sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))
  const lock = privateRow.getByLabel("Private channel",{exact:true})
  await expect(lock).toBeVisible()
  const icons = privateRow.locator("svg")
  expect((await lock.boundingBox())!.x).toBeLessThan((await icons.nth(1).boundingBox())!.x)
  await expect(sheet.getByTestId(tid.botMembershipsChannel(`/${studio.handle}/announcements`)).getByLabel("Private channel",{exact:true})).toHaveCount(0)
  for (const action of await actions.all()) {
    const bounds = (await action.boundingBox())!
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    expect(bounds.width).toBeGreaterThanOrEqual(44)
    await expect(action).toHaveAccessibleName(/Leave/)
    expect((await action.innerText()).trim()).toBe("")
  }
  await page.screenshot({path:testInfo.outputPath("memberships-mobile.png"),style})
  await sheet.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
  const confirmation = page.getByRole("alertdialog")
  await expect(confirmation).toContainText("Membership-studio")
  expect((await page.getByTestId(tid.botMembershipsConfirm).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await confirmation.getByRole("button",{name:"Cancel",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({path:testInfo.outputPath("memberships-mobile-confirm.png"),style})
  await confirmation.getByRole("button",{name:"Cancel",exact:true}).click()
  await sheet.getByTestId(tid.botMembershipsLeave(`/${studio.handle}/announcements`)).click()
  await expect(confirmation).toContainText("public")
  await expect(confirmation).toContainText("Membership-studio")
  await expect(page.getByTestId(tid.botMembershipsConfirm)).toHaveText("Leave server")
  await page.screenshot({path:testInfo.outputPath("memberships-mobile-public-confirm.png"),style})
  await confirmation.getByRole("button",{name:"Cancel",exact:true}).click()
  await expect(sheet.getByTestId(tid.botMembershipsServer(studio.id))).toBeVisible()
  await page.keyboard.press("Escape")
  expect((await call(`/api/community/bots/${first.id}`,"DELETE")).status).toBe(204)
  expect((await call("/api/community/servers/channels","GET",undefined,{[COMMUNITY_BOT_ACTOR_HEADER]:first.id})).status).toBe(404)
})
