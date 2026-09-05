import type { Locator } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { solidPngFixture, structuredJpegFixture } from "../fixtures/media"

const ARTIFACT_IMAGE = solidPngFixture(800, 450, [39, 111, 191])
const ARTIFACT_THUMBNAIL = structuredJpegFixture(320, 180)

async function expectStableFrame(frame: Locator, expected: { width: number; height: number }) {
  await expect.poll(async () => {
    const box = await frame.boundingBox()
    return box ? { width: box.width, height: box.height } : null
  }).toEqual(expected)
}

test("Workspace artifact thumbnails and full images hold geometry through failure and exact-URL retry", async ({ asUser }) => {
  test.setTimeout(180_000)
  const { context, page } = await asUser("alice", { viewport: { width: 1280, height: 800 } })
  const suffix = Date.now().toString(36)
  const slug = `remote-image-${suffix}`

  const workspaceResponse = await context.request.post("/api/workspaces", {
    data: { name: `Remote image ${suffix}`, slug },
  })
  expect(workspaceResponse.status()).toBe(201)
  const workspace = await workspaceResponse.json() as { id: string; slug: string }
  const onboardedResponse = await context.request.post(`/api/workspaces/${workspace.id}/onboarded`)
  expect(onboardedResponse.status()).toBe(200)

  const tokenResponse = await context.request.post(`/api/machine-tokens?workspace_id=${workspace.id}`, {
    data: { name: `remote-image-${suffix}` },
  })
  expect(tokenResponse.status()).toBe(201)
  const { token } = await tokenResponse.json() as { token: string }
  const activationResponse = await context.request.post("/api/machine-tokens/activate", {
    data: {
      token,
      hostname: `remote-image-${suffix}`,
      runtimes: [{ type: "codex", version: "e2e" }],
    },
  })
  expect(activationResponse.status()).toBe(200)
  const activation = await activationResponse.json() as { runtimes: Array<{ id: string }> }

  const agentResponse = await context.request.post(`/api/agents?workspace_id=${workspace.id}`, {
    data: {
      name: `Remote Image ${suffix}`,
      description: "",
      instructions: "",
      runtime_id: activation.runtimes[0]!.id,
    },
  })
  expect(agentResponse.status()).toBe(201)
  const agent = await agentResponse.json() as { id: string }
  const conversationResponse = await context.request.post(
    `/api/agents/${agent.id}/conversation?workspace_id=${workspace.id}`,
    { data: {} },
  )
  expect(conversationResponse.status()).toBe(200)
  const conversation = await conversationResponse.json() as { id: string }

  const messageResponse = await context.request.post(
    `/api/conversations/${conversation.id}/messages?workspace_id=${workspace.id}`,
    {
      multipart: {
        content: "Review this artifact",
        file: {
          name: "artifact.png",
          mimeType: "image/png",
          buffer: ARTIFACT_IMAGE,
        },
        "thumbnail:0": {
          name: "thumbnail.jpg",
          mimeType: "image/jpeg",
          buffer: ARTIFACT_THUMBNAIL,
        },
      },
    },
  )
  expect([201, 500]).toContain(messageResponse.status())

  let releaseThumbnailFailure!: () => void
  const thumbnailGate = new Promise<void>((resolve) => { releaseThumbnailFailure = resolve })
  let thumbnailRequests = 0
  await page.route("**/api/artifacts/*/thumbnail?*", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    thumbnailRequests += 1
    if (thumbnailRequests === 1) {
      await thumbnailGate
      return route.fulfill({ status: 503, body: "thumbnail unavailable" })
    }
    return route.continue()
  })

  await page.goto(`/w/${workspace.slug}/agents/${agent.id}`, { waitUntil: "commit" })
  const thumbnail = page.locator('img[alt="artifact.png"][src*="/thumbnail"]')
  await expect(thumbnail).toHaveAttribute("data-remote-image-state", "pending", { timeout: 20_000 })
  const thumbnailFrame = thumbnail.locator("xpath=ancestor::*[@data-remote-image-frame][1]")
  const thumbnailPendingBox = await thumbnailFrame.boundingBox()
  expect(thumbnailPendingBox).not.toBeNull()
  const thumbnailSize = {
    width: thumbnailPendingBox!.width,
    height: thumbnailPendingBox!.height,
  }

  releaseThumbnailFailure()
  await expect(thumbnail).toHaveAttribute("data-remote-image-state", "error")
  await expect(thumbnailFrame.getByRole("button", { name: "Retry" })).toBeVisible()
  await expectStableFrame(thumbnailFrame, thumbnailSize)
  const thumbnailUrl = await thumbnail.getAttribute("src")
  await thumbnailFrame.getByRole("button", { name: "Retry" }).click()
  await expect.poll(() => thumbnailRequests).toBe(2)
  await expect(thumbnail).toHaveAttribute("src", thumbnailUrl!)
  await expect(thumbnail).toHaveAttribute("data-remote-image-state", "ready")
  await expectStableFrame(thumbnailFrame, thumbnailSize)
  await page.unroute("**/api/artifacts/*/thumbnail?*")

  let releaseContentFailure!: () => void
  const contentGate = new Promise<void>((resolve) => { releaseContentFailure = resolve })
  let contentRequests = 0
  await page.route("**/api/artifacts/*/content?*", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    contentRequests += 1
    if (contentRequests === 1) {
      await contentGate
      return route.fulfill({ status: 503, body: "content unavailable" })
    }
    return route.continue()
  })

  await page.getByRole("button", { name: "Open artifact.png" }).first().click()
  const fullImage = page.locator('img[alt="artifact.png"][src*="/content"]')
  await expect(fullImage).toHaveAttribute("data-remote-image-state", "pending")
  await expect(page.getByRole("link", { name: "Download artifact.png" })).toBeVisible()
  const contentFrame = fullImage.locator("xpath=ancestor::*[@data-remote-image-frame][1]")
  const contentPendingBox = await contentFrame.boundingBox()
  expect(contentPendingBox).not.toBeNull()
  const contentSize = {
    width: contentPendingBox!.width,
    height: contentPendingBox!.height,
  }

  releaseContentFailure()
  await expect(fullImage).toHaveAttribute("data-remote-image-state", "error")
  await expectStableFrame(contentFrame, contentSize)
  const contentUrl = await fullImage.getAttribute("src")
  await contentFrame.getByRole("button", { name: "Retry" }).click()
  await expect.poll(() => contentRequests).toBe(2)
  await expect(fullImage).toHaveAttribute("src", contentUrl!)
  await expect(fullImage).toHaveAttribute("data-remote-image-state", "ready")
  await expectStableFrame(contentFrame, contentSize)
  await page.getByRole("button", { name: "Close image" }).click()
  await expect(fullImage).toHaveCount(0)
})
