import { describe, expect, it } from "vitest"
import {
  BOT_WEBHOOK_PROMPT_MAX_LENGTH,
  BOT_WEBHOOK_PROVIDER_META,
  BOT_WEBHOOK_PROVIDERS,
  BotWebhookCreateSchema,
  BotWebhookUpdateSchema,
  buildBotWebhookEventPrompt,
  formatGenericWebhookEvent,
  formatGitHubWebhookEvent,
  formatGitLabWebhookEvent,
  formatLinearWebhookEvent,
  formatSentryWebhookEvent,
  formatSlackWebhookEvent,
  formatStandardWebhookEvent,
  formatStripeWebhookEvent,
  formatVercelWebhookEvent,
} from "./bot-webhook"

describe("bot-webhook schemas and formatters", () => {
  it("validates create and update schemas", () => {
    const created = BotWebhookCreateSchema.parse({
      name: "  Alook CI  ",
      provider: "github",
      eventFilter: ["Workflow_Run", "pull_request", "workflow_run"],
      instruction: "  Inspect failed runs  ",
    })
    expect(created).toEqual({
      name: "Alook CI",
      provider: "github",
      eventFilter: ["workflow_run", "pull_request"],
      instruction: "Inspect failed runs",
    })

    expect(() => BotWebhookUpdateSchema.parse({})).toThrow()
    expect(BotWebhookUpdateSchema.parse({ rotateCredentials: true })).toEqual({
      rotateCredentials: true,
    })
  })

  it("compacts GitHub workflow_run and pull_request payloads cleanly", () => {
    const wf = formatGitHubWebhookEvent("workflow_run", {
      action: "completed",
      repository: { full_name: "alookai/alook" },
      sender: { login: "octocat" },
      workflow_run: {
        id: 98765,
        run_attempt: 2,
        name: "CI Gate",
        status: "completed",
        conclusion: "failure",
        head_branch: "feat/bot-webhooks",
        head_sha: "abcdef1234567890abcdef",
        html_url: "https://github.com/alookai/alook/actions/runs/98765",
        pull_requests: [{ number: 1495 }],
      },
    })
    expect(wf.eventType).toBe("workflow_run.completed")
    expect(wf.summary).toContain("alookai/alook")
    expect(wf.summary).toContain("CI Gate failure")
    expect(wf.summary).toContain("#1495")
    expect(wf.payloadText).toContain("Head SHA: abcdef123456")
    expect(wf.payloadText).toContain("Run ID: 98765 (attempt 2)")

    const pr = formatGitHubWebhookEvent("pull_request", {
      action: "closed",
      repository: { full_name: "alookai/alook" },
      sender: { login: "gus" },
      pull_request: {
        number: 1495,
        title: "Add bot webhooks",
        state: "closed",
        merged: true,
        head: { ref: "feat/bot-webhooks", sha: "1122334455667788" },
        base: { ref: "main" },
        html_url: "https://github.com/alookai/alook/pull/1495",
      },
    })
    expect(pr.eventType).toBe("pull_request.closed")
    expect(pr.summary).toContain("PR #1495 merged")
    expect(pr.payloadText).toContain("Branches: feat/bot-webhooks -> main")
  })

  it("formats generic JSON and plain text payloads and bounds prompt size with isolation fence", () => {
    const jsonEvent = formatGenericWebhookEvent(
      JSON.stringify({ event: "deploy.failed", summary: "Worker deploy failed", detail: "OOM" }),
      "application/json",
      null,
    )
    expect(jsonEvent.eventType).toBe("deploy.failed")
    expect(jsonEvent.summary).toBe("Worker deploy failed")

    const textEvent = formatGenericWebhookEvent("Build finished with 0 warnings", "text/plain", "build")
    expect(textEvent.eventType).toBe("build")
    expect(textEvent.summary).toBe("Build finished with 0 warnings")

    const prompt = buildBotWebhookEventPrompt({
      webhookName: "Alook CI",
      provider: "github",
      eventType: "workflow_run.completed",
      deliveryId: "whd_1",
      externalDeliveryId: "gh-deliv-1",
      instruction: "Fix failing tests",
      payloadText: "X".repeat(20_000),
    })
    expect(prompt.length).toBeLessThanOrEqual(BOT_WEBHOOK_PROMPT_MAX_LENGTH)
    expect(prompt).toContain("untrusted external data")
    expect(prompt).toContain("Owner instruction: Fix failing tests")
    expect(prompt).toContain("--- BEGIN EXTERNAL PAYLOAD ---")
    expect(prompt).toContain("--- END EXTERNAL PAYLOAD ---")
  })

  it("exposes metadata for all explicit providers (concrete platforms first, generic last) and formats each protocol", () => {
    expect(BOT_WEBHOOK_PROVIDERS.at(-1)).toBe("generic")
    for (const provider of BOT_WEBHOOK_PROVIDERS) {
      expect(BOT_WEBHOOK_PROVIDER_META[provider].id).toBe(provider)
      expect(BOT_WEBHOOK_PROVIDER_META[provider].setupSteps.length).toBeGreaterThan(0)
    }

    expect(
      BotWebhookCreateSchema.parse({
        name: "Billing",
        provider: "stripe",
        signingSecret: "  whsec_stripe_123456  ",
      }).signingSecret,
    ).toBe("whsec_stripe_123456")

    expect(
      formatLinearWebhookEvent("Issue", {
        type: "Issue",
        action: "create",
        data: { identifier: "ENG-42", title: "Fix login crash", state: { name: "Todo" } },
      }).summary,
    ).toContain("ENG-42 Fix login crash")

    expect(
      formatSentryWebhookEvent("issue", {
        action: "created",
        data: { issue: { title: "TypeError: boom", project: { slug: "web" }, level: "error" } },
      }).summary,
    ).toContain("[web]")

    expect(
      formatStripeWebhookEvent({
        id: "evt_1",
        type: "invoice.payment_failed",
        livemode: true,
        data: { object: { id: "in_1", amount_due: 4900, currency: "usd", status: "open" } },
      }).summary,
    ).toContain("49.00 USD")

    expect(
      formatVercelWebhookEvent({
        id: "uev_1",
        type: "deployment.error",
        payload: { deployment: { name: "alook-web", url: "alook.vercel.app", meta: { githubCommitRef: "main" } } },
      }).summary,
    ).toContain("alook-web")

    expect(
      formatGitLabWebhookEvent("Merge Request Hook", {
        object_kind: "merge_request",
        project: { path_with_namespace: "org/app" },
        object_attributes: { iid: 12, action: "open", title: "Add webhooks" },
      }).summary,
    ).toContain("!12")

    expect(
      formatSlackWebhookEvent({
        type: "event_callback",
        event: { type: "app_mention", channel: "C123", user: "U456", text: "deploy status?" },
      }).summary,
    ).toContain("deploy status?")

    expect(
      formatStandardWebhookEvent("OpenAI", {
        type: "batch.completed",
        data: { id: "batch_1", status: "completed" },
      }).summary,
    ).toContain("OpenAI batch.completed")

    expect(
      formatGenericWebhookEvent(
        JSON.stringify({ alert_type: "worker_error", text: "Worker exception rate high" }),
        "application/json",
        null,
        "Cloudflare",
      ).summary,
    ).toContain("Cloudflare: Worker exception rate high")
  })
})
