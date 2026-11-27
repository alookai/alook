"use client"

import { useLayoutEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import {
  BOT_WEBHOOK_GITHUB_DEFAULT_EVENTS,
  BOT_WEBHOOK_GITHUB_KNOWN_EVENTS,
  BOT_WEBHOOK_INSTRUCTION_MAX_LENGTH,
  BOT_WEBHOOK_MAX_PER_BOT,
  BOT_WEBHOOK_NAME_MAX_LENGTH,
  BotWebhookCreateSchema,
  BotWebhookUpdateSchema,
  type BotWebhookDelivery,
  type BotWebhookDeliveryStatus,
  type BotWebhookProvider,
  type BotWebhookSummary,
} from "@alook/shared"
import {
  Check,
  ChevronDown,
  Copy,
  Link2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "@/components/icons/lucide"
import { toast } from "sonner"
import { AgentAvatar } from "@/components/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useBotWebhookDeliveries, useBotWebhooks } from "@/hooks/community/use-bot-webhooks"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { getErrorMessage } from "@/lib/api/client"
import { formatRelativeTime } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { isAbortError } from "@/lib/errors"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import { EmptyState } from "../empty-state"
import { CommunitySheet } from "../shell/community-sheet"

const control = "h-11 sm:h-8"
const KNOWN_GITHUB_SET = new Set<string>(BOT_WEBHOOK_GITHUB_KNOWN_EVENTS)

type RevealedCredentials = {
  heading: string
  webhook: BotWebhookSummary
  webhookUrl?: string
  signingSecret: string | null
}

function formatDeliveryError(error: string | null): string | null {
  if (!error) return null
  switch (error) {
    case "machine_offline":
      return "Machine offline — queued until reconnect"
    case "bot_inactive":
      return "Bot is inactive"
    case "bot_unbound":
      return "Bot has no machine assigned"
    default:
      return error
  }
}

function deliveryStatusLabel(status: BotWebhookDeliveryStatus, lastError: string | null): string {
  switch (status) {
    case "dispatched":
      return "Delivered"
    case "pending":
      return lastError === "machine_offline" ? "Queued · offline" : "Pending"
    case "ignored":
      return "Ignored"
    case "failed":
      return "Failed"
  }
}

function deliveryBadgeVariant(status: BotWebhookDeliveryStatus): "secondary" | "outline" | "destructive" {
  switch (status) {
    case "dispatched":
      return "secondary"
    case "failed":
      return "destructive"
    default:
      return "outline"
  }
}

function providerLabel(provider: BotWebhookProvider): string {
  return provider === "github" ? "GitHub" : "Generic"
}

function webhookSubtitle(webhook: BotWebhookSummary): string {
  const parts: string[] = []
  if (webhook.provider === "github") {
    parts.push(
      webhook.eventFilter === null
        ? "All GitHub events"
        : `${webhook.eventFilter.length} GitHub ${webhook.eventFilter.length === 1 ? "event" : "events"}`,
    )
  } else {
    parts.push(webhook.hasSigningSecret ? "Secret required" : "Direct JSON")
  }
  if (webhook.lastTriggeredAt) {
    parts.push(`Triggered ${formatRelativeTime(webhook.lastTriggeredAt)}`)
  }
  return parts.join(" · ")
}

function parseCustomEvents(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}

function CopyableCredentialField({
  id,
  label,
  value,
  testId,
}: {
  id: string
  label: string
  value: string
  testId: string
}) {
  const [copyState, setCopyState] = useAtom(useCreateAtom<"idle" | "copied" | "error">("idle"))
  const source = useCommunityViewSource(`webhook-copy:${id}`)
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-testid={testId}
          className={`${control} min-w-0 flex-1 font-mono text-xs`}
          readOnly
          value={value}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          className={`${control} shrink-0 gap-1.5`}
          aria-label={`Copy ${label}`}
          onClick={async () => {
            const assert = source.capture()
            try {
              assert()
              await navigator.clipboard.writeText(value)
              assert()
              setCopyState("copied")
            } catch (cause) {
              if (!isAbortError(cause)) {
                try {
                  assert()
                  setCopyState("error")
                } catch {
                  return
                }
              }
            }
          }}
        >
          {copyState === "copied" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      {copyState === "error" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Copy failed. Select the field and copy it manually.
        </p>
      ) : null}
    </div>
  )
}

function CredentialsReveal({
  revealed,
  testing,
  onSendTest,
  onDone,
}: {
  revealed: RevealedCredentials
  testing: boolean
  onSendTest: (webhook: BotWebhookSummary) => Promise<void>
  onDone: () => void
}) {
  const [confirmDone, setConfirmDone] = useAtom(useCreateAtom(false))
  const isGitHub = revealed.webhook.provider === "github"
  return (
    <section className="space-y-6" data-testid={tid.botWebhookCredentialsPanel}>
      <div className="space-y-1.5">
        <h3 className="text-base font-medium">{revealed.heading}</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Copy these credentials now. You cannot view the full URL or signing secret again after leaving this screen.
        </p>
      </div>

      <div className="space-y-4">
        {revealed.webhookUrl ? (
          <CopyableCredentialField
            id="bot-webhook-url"
            label="Webhook URL"
            value={revealed.webhookUrl}
            testId={tid.botWebhookUrlValue}
          />
        ) : null}
        {revealed.signingSecret ? (
          <CopyableCredentialField
            id="bot-webhook-secret"
            label="Signing secret"
            value={revealed.signingSecret}
            testId={tid.botWebhookSecretValue}
          />
        ) : null}
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
        {isGitHub ? (
          <>
            <p className="font-medium text-foreground">Set up in GitHub</p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Open repository Settings → Webhooks → Add webhook.</li>
              <li>Paste the Webhook URL, choose <code className="font-mono text-foreground">application/json</code>, and paste the Signing secret.</li>
              <li>Select the events you enabled here and save the webhook.</li>
            </ol>
          </>
        ) : (
          <>
            <p className="font-medium text-foreground">Send JSON directly to this bot</p>
            <p>
              POST JSON or plain text to the Webhook URL.
              {revealed.signingSecret
                ? " Include the signing secret in X-Webhook-Secret or Authorization: Bearer."
                : " No extra signature header is required."}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          className={`${control} gap-1.5`}
          disabled={testing}
          onClick={() => { void onSendTest(revealed.webhook) }}
        >
          <Play className="size-3.5" aria-hidden />
          {testing ? "Sending test…" : "Send test"}
        </Button>
        <Button type="button" className={control} onClick={() => setConfirmDone(true)}>
          Done
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDone}
        onOpenChange={setConfirmDone}
        title="Have you saved these credentials?"
        description="You cannot view the full URL or signing secret again after leaving this screen."
        confirmLabel="I've saved them"
        confirmVariant="default"
        onConfirm={onDone}
      />
    </section>
  )
}

function WebhookForm({
  webhook,
  pending,
  onCancel,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  webhook?: BotWebhookSummary
  pending: boolean
  onCancel: () => void
  onSubmitCreate: (input: {
    name: string
    provider: BotWebhookProvider
    eventFilter: string[] | null
    instruction: string
    requireSecret?: boolean
  }) => Promise<void>
  onSubmitUpdate: (
    webhookId: string,
    input: {
      name: string
      eventFilter: string[] | null
      instruction: string
      requireSecret?: boolean
    },
  ) => Promise<void>
}) {
  const initialEvents = webhook
    ? (webhook.eventFilter ?? [])
    : [...BOT_WEBHOOK_GITHUB_DEFAULT_EVENTS]
  const initialKnown = initialEvents.filter((event) => KNOWN_GITHUB_SET.has(event))
  const initialCustom = initialEvents.filter((event) => !KNOWN_GITHUB_SET.has(event)).join(", ")

  const [name, setName] = useAtom(useCreateAtom(webhook?.name ?? ""))
  const [provider, setProvider] = useAtom(useCreateAtom<BotWebhookProvider>(webhook?.provider ?? "generic"))
  const [requireSecret, setRequireSecret] = useAtom(useCreateAtom(webhook?.hasSigningSecret ?? false))
  const [eventMode, setEventMode] = useAtom(
    useCreateAtom<"selected" | "all">(webhook && webhook.eventFilter === null ? "all" : "selected"),
  )
  const [selectedEvents, setSelectedEvents] = useAtom(useCreateAtom<string[]>(initialKnown))
  const [customEventsText, setCustomEventsText] = useAtom(useCreateAtom(initialCustom))
  const [instruction, setInstruction] = useAtom(useCreateAtom(webhook?.instruction ?? ""))
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))

  const toggleEvent = (eventName: string) => {
    setSelectedEvents((current) =>
      current.includes(eventName)
        ? current.filter((item) => item !== eventName)
        : [...current, eventName],
    )
  }

  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault()
        if (pending) return
        setError(null)

        const computedEvents =
          provider === "github"
            ? eventMode === "all"
              ? null
              : [...selectedEvents, ...parseCustomEvents(customEventsText)]
            : null

        if (provider === "github" && eventMode === "selected" && (!computedEvents || computedEvents.length === 0)) {
          setError("Select at least one GitHub event or switch to all events.")
          return
        }

        if (webhook) {
          const parsed = BotWebhookUpdateSchema.safeParse({
            name,
            instruction,
            eventFilter: computedEvents,
            ...(provider === "generic" ? { requireSecret } : {}),
          })
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
            return
          }
          try {
            await onSubmitUpdate(webhook.id, {
              name: parsed.data.name ?? name.trim(),
              instruction: parsed.data.instruction ?? instruction.trim(),
              eventFilter: parsed.data.eventFilter ?? null,
              ...(provider === "generic" ? { requireSecret } : {}),
            })
          } catch (cause) {
            if (!isAbortError(cause)) {
              setError(getErrorMessage(cause, "Could not update this webhook. Try again."))
            }
          }
          return
        }

        const parsed = BotWebhookCreateSchema.safeParse({
          name,
          provider,
          instruction,
          eventFilter: computedEvents,
          ...(provider === "generic" ? { requireSecret } : {}),
        })
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
          return
        }
        try {
          await onSubmitCreate({
            name: parsed.data.name,
            provider: parsed.data.provider,
            instruction: parsed.data.instruction,
            eventFilter: parsed.data.eventFilter ?? null,
            ...(parsed.data.provider === "generic" ? { requireSecret } : {}),
          })
        } catch (cause) {
          if (!isAbortError(cause)) {
            setError(getErrorMessage(cause, "Could not create this webhook. Try again."))
          }
        }
      }}
    >
      <div className="space-y-1">
        <h3 className="text-base font-medium">{webhook ? "Edit webhook" : "New webhook"}</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Events sent to this webhook wake this bot directly without posting in a channel.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="bot-webhook-name" className="block text-sm font-medium">
          Name
        </label>
        <Input
          id="bot-webhook-name"
          data-testid={tid.botWebhookNameInput}
          className={control}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={BOT_WEBHOOK_NAME_MAX_LENGTH}
          placeholder={provider === "github" ? "e.g. alook CI" : "e.g. Deploy alerts"}
          autoComplete="off"
          required
          disabled={pending}
        />
      </div>

      <fieldset className="space-y-2" disabled={pending}>
        <legend className="text-sm font-medium">Payload format</legend>
        {webhook ? (
          <div className="flex items-center gap-2 pt-1">
            <Badge variant="secondary">{providerLabel(webhook.provider)}</Badge>
            <span className="text-xs text-muted-foreground">
              {webhook.provider === "github"
                ? "Verifies GitHub signatures and summarizes GitHub events."
                : "Forwards raw JSON or text straight to this bot."}
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                {
                  id: "generic",
                  title: "Generic (direct JSON)",
                  detail: "Forward raw webhook JSON or text straight to this bot.",
                },
                {
                  id: "github",
                  title: "GitHub adapter",
                  detail: "Verify signatures, deduplicate, and summarize CI, PR, and issue events.",
                },
              ] as const
            ).map((option) => {
              const selected = provider === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  data-testid={tid.botWebhookProviderSelect(option.id)}
                  aria-pressed={selected}
                  onClick={() => setProvider(option.id)}
                  className={[
                    "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    selected
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  ].join(" ")}
                >
                  <span className="text-sm font-medium text-foreground">{option.title}</span>
                  <span className="text-xs leading-5 text-muted-foreground">{option.detail}</span>
                </button>
              )
            })}
          </div>
        )}
      </fieldset>

      {provider === "github" ? (
        <fieldset className="space-y-3" disabled={pending}>
          <legend className="text-sm font-medium">GitHub events</legend>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={eventMode === "selected" ? "default" : "outline"}
              className="h-9 sm:h-7"
              data-testid={tid.botWebhookEventMode("selected")}
              onClick={() => setEventMode("selected")}
            >
              Selected events
            </Button>
            <Button
              type="button"
              size="sm"
              variant={eventMode === "all" ? "default" : "outline"}
              className="h-9 sm:h-7"
              data-testid={tid.botWebhookEventMode("all")}
              onClick={() => setEventMode("all")}
            >
              All events
            </Button>
          </div>
          {eventMode === "selected" ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {BOT_WEBHOOK_GITHUB_KNOWN_EVENTS.map((eventName) => {
                  const active = selectedEvents.includes(eventName)
                  return (
                    <Button
                      key={eventName}
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "outline"}
                      data-testid={tid.botWebhookEventChip(eventName)}
                      aria-pressed={active}
                      className="h-8 font-mono text-xs sm:h-7"
                      onClick={() => toggleEvent(eventName)}
                    >
                      {eventName}
                    </Button>
                  )
                })}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bot-webhook-custom-events" className="block text-xs font-medium text-muted-foreground">
                  Extra event names (optional, comma-separated)
                </label>
                <Input
                  id="bot-webhook-custom-events"
                  data-testid={tid.botWebhookCustomEventsInput}
                  className={`${control} font-mono text-xs`}
                  value={customEventsText}
                  onChange={(event) => setCustomEventsText(event.target.value)}
                  placeholder="e.g. deployment_status, discussion"
                  autoComplete="off"
                />
              </div>
            </>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Accept every GitHub event sent to this URL. Ping checks are still acknowledged without waking the bot.
            </p>
          )}
        </fieldset>
      ) : (
        <div className="space-y-1.5">
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 sm:min-h-8">
            <span className="text-sm font-medium">Require signing secret</span>
            <Switch
              data-testid={tid.botWebhookRequireSecret}
              checked={requireSecret}
              onCheckedChange={setRequireSecret}
              disabled={pending}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            {requireSecret
              ? "Callers must send X-Webhook-Secret or Authorization: Bearer. A secret will be shown once after saving."
              : "Any caller with the high-entropy webhook URL can trigger this bot."}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="bot-webhook-instruction" className="block text-sm font-medium">
          Handling instruction (optional)
        </label>
        <Textarea
          id="bot-webhook-instruction"
          data-testid={tid.botWebhookInstructionInput}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          maxLength={BOT_WEBHOOK_INSTRUCTION_MAX_LENGTH}
          rows={3}
          placeholder="e.g. If CI fails, inspect the logs, fix the issue, and report back in the task thread."
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          Attached above the external payload whenever this webhook wakes the bot.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className={control} onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className={control} data-testid={tid.botWebhookSubmit} disabled={pending}>
          {pending ? "Saving…" : webhook ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  )
}

function DeliveriesPanel({
  botId,
  webhookId,
}: {
  botId: string
  webhookId: string
}) {
  const deliveriesQuery = useBotWebhookDeliveries(botId, webhookId, true)
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Recent deliveries</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label="Refresh deliveries"
          disabled={deliveriesQuery.isFetching}
          onClick={() => { void deliveriesQuery.refetch() }}
        >
          <RefreshCw
            aria-hidden
            className={`size-3.5 ${deliveriesQuery.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
        </Button>
      </div>
      {deliveriesQuery.isPending && !deliveriesQuery.data ? (
        <div className="space-y-2" aria-label="Loading deliveries" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : deliveriesQuery.isError ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>Could not load recent deliveries.</span>
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => { void deliveriesQuery.refetch() }}>
            Retry
          </Button>
        </div>
      ) : deliveriesQuery.deliveries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No deliveries yet. Send a test notification to verify the wake path.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {deliveriesQuery.deliveries.map((delivery: BotWebhookDelivery) => {
            const errorDetail = formatDeliveryError(delivery.lastError)
            return (
              <li
                key={delivery.id}
                data-testid={tid.botWebhookDeliveryRow(delivery.id)}
                className="space-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={deliveryBadgeVariant(delivery.status)}>
                    {deliveryStatusLabel(delivery.status, delivery.lastError)}
                  </Badge>
                  <code className="font-mono text-xs text-foreground">{delivery.eventType}</code>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelativeTime(delivery.createdAt)}
                  </span>
                </div>
                <p className="wrap-break-word text-xs leading-5 text-muted-foreground">{delivery.summary}</p>
                {errorDetail ? (
                  <p className="text-xs text-muted-foreground">{errorDetail}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function BotWebhooksSheet({
  bot,
  open,
  onOpenChange,
}: {
  bot: { id: string; name: string; image?: string | null }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const webhooksApi = useBotWebhooks(bot.id, open)
  const [editing, setEditing] = useAtom(useCreateAtom<BotWebhookSummary | "new" | null>(null))
  const [revealed, setRevealed] = useAtom(useCreateAtom<RevealedCredentials | null>(null))
  const [expandedDeliveriesId, setExpandedDeliveriesId] = useAtom(useCreateAtom<string | null>(null))
  const [confirmRotate, setConfirmRotate] = useAtom(useCreateAtom<BotWebhookSummary | null>(null))
  const [confirmDelete, setConfirmDelete] = useAtom(useCreateAtom<BotWebhookSummary | null>(null))
  const [actionError, setActionError] = useAtom(useCreateAtom<string | null>(null))

  useLayoutEffect(() => {
    setEditing(null)
    setRevealed(null)
    setExpandedDeliveriesId(null)
    setConfirmRotate(null)
    setConfirmDelete(null)
    setActionError(null)
  }, [bot.id, open, setEditing, setRevealed, setExpandedDeliveriesId, setConfirmRotate, setConfirmDelete, setActionError])

  const atLimit = webhooksApi.webhooks.length >= BOT_WEBHOOK_MAX_PER_BOT

  const handleSendTest = async (webhook: BotWebhookSummary) => {
    setActionError(null)
    try {
      const { delivery } = await webhooksApi.testWebhook(webhook.id)
      if (delivery.status === "dispatched") {
        toast.success(`Test sent to ${bot.name}`)
      } else if (delivery.status === "pending") {
        toast.success(`Test queued — ${bot.name}'s machine is offline`)
      } else {
        toast.error(formatDeliveryError(delivery.lastError) ?? "Could not wake this bot")
      }
      setExpandedDeliveriesId(webhook.id)
    } catch (cause) {
      if (!isAbortError(cause)) {
        setActionError(getErrorMessage(cause, "Could not send a test notification. Try again."))
      }
    }
  }

  return (
    <>
      <CommunitySheet
        open={open}
        onOpenChange={onOpenChange}
        title="Webhooks"
        description={
          <span className="flex min-w-0 items-center gap-2">
            <AgentAvatar name={bot.name} avatarUrl={bot.image} seed={bot.id} size={24} />
            <span className="min-w-0 truncate" title={bot.name}>
              {bot.name}
            </span>
          </span>
        }
        contentTestId={tid.botWebhooksSheet}
        bodyClassName="flex flex-col gap-6"
      >
        {revealed ? (
          <CredentialsReveal
            revealed={revealed}
            testing={webhooksApi.testingWebhookId === revealed.webhook.id}
            onSendTest={handleSendTest}
            onDone={() => setRevealed(null)}
          />
        ) : editing ? (
          <WebhookForm
            key={editing === "new" ? "new" : editing.id}
            webhook={editing === "new" ? undefined : editing}
            pending={webhooksApi.creating || webhooksApi.updating}
            onCancel={() => setEditing(null)}
            onSubmitCreate={async (input) => {
              const created = await webhooksApi.createWebhook(input)
              setEditing(null)
              setRevealed({
                heading: "Webhook created",
                webhook: created.webhook,
                webhookUrl: created.webhookUrl,
                signingSecret: created.signingSecret,
              })
            }}
            onSubmitUpdate={async (webhookId, input) => {
              const updated = await webhooksApi.updateWebhook(webhookId, input)
              setEditing(null)
              if (updated.webhookUrl || updated.signingSecret) {
                setRevealed({
                  heading: "Signing secret generated",
                  webhook: updated.webhook,
                  webhookUrl: updated.webhookUrl,
                  signingSecret: updated.signingSecret ?? null,
                })
              } else {
                toast.success("Webhook updated")
              }
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
                Wake {bot.name} directly from GitHub or external services without posting to channels.
              </p>
              <Button
                type="button"
                className={`${control} shrink-0 gap-1.5`}
                data-testid={tid.botWebhooksCreateOpen}
                disabled={atLimit}
                title={atLimit ? `Maximum of ${BOT_WEBHOOK_MAX_PER_BOT} webhooks per bot reached.` : undefined}
                onClick={() => {
                  setActionError(null)
                  setEditing("new")
                }}
              >
                <Plus className="size-4" aria-hidden />
                New webhook
              </Button>
            </div>

            {webhooksApi.isError && webhooksApi.data ? (
              <ConversationResolutionErrorFrame
                as="div"
                title="Could not refresh webhooks."
                retrying={webhooksApi.isFetching}
                onRetry={() => { void webhooksApi.refetch() }}
              />
            ) : null}

            {webhooksApi.isPending && !webhooksApi.data ? (
              <div className="space-y-4" aria-label="Loading webhooks" role="status">
                {[0, 1].map((index) => (
                  <div key={index} className="space-y-2 py-3">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-56 max-w-full" />
                    <Skeleton className="h-8 w-48" />
                  </div>
                ))}
              </div>
            ) : webhooksApi.isError && !webhooksApi.data ? (
              <ConversationResolutionErrorFrame
                as="div"
                title="Could not load webhooks."
                retrying={webhooksApi.isFetching}
                onRetry={() => { void webhooksApi.refetch() }}
              />
            ) : webhooksApi.webhooks.length === 0 ? (
              <EmptyState
                icon={Link2}
                label="No webhooks yet"
                description={`Create a webhook to let GitHub or external services wake ${bot.name} directly.`}
              />
            ) : (
              <ul className="divide-y divide-border">
                {webhooksApi.webhooks.map((webhook) => {
                  const deliveriesExpanded = expandedDeliveriesId === webhook.id
                  const toggling = webhooksApi.togglingWebhookId === webhook.id
                  const testingThis = webhooksApi.testingWebhookId === webhook.id
                  const lastErrorText = formatDeliveryError(webhook.lastDelivery?.lastError ?? null)
                  return (
                    <li
                      key={webhook.id}
                      data-testid={tid.botWebhookCard(webhook.id)}
                      className="space-y-3 py-4 first:pt-0"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="min-w-0 wrap-break-word text-sm font-medium text-foreground">
                              {webhook.name}
                            </h3>
                            <Badge variant="secondary">{providerLabel(webhook.provider)}</Badge>
                            {!webhook.enabled ? <Badge variant="outline">Paused</Badge> : null}
                          </div>
                          <p className="text-xs leading-5 text-muted-foreground">
                            {webhookSubtitle(webhook)}
                          </p>
                        </div>
                        <Switch
                          data-testid={tid.botWebhookToggle(webhook.id)}
                          checked={webhook.enabled}
                          disabled={toggling}
                          aria-label={webhook.enabled ? `Pause ${webhook.name}` : `Enable ${webhook.name}`}
                          onCheckedChange={async (checked) => {
                            setActionError(null)
                            try {
                              await webhooksApi.updateWebhook(webhook.id, { enabled: checked })
                              toast.success(checked ? `${webhook.name} enabled` : `${webhook.name} paused`)
                            } catch (cause) {
                              if (!isAbortError(cause)) {
                                setActionError(getErrorMessage(cause, "Could not update webhook status. Try again."))
                              }
                            }
                          }}
                        />
                      </div>

                      {webhook.instruction ? (
                        <p className="line-clamp-2 wrap-break-word text-xs leading-5 text-muted-foreground">
                          {webhook.instruction}
                        </p>
                      ) : null}

                      {webhook.lastDelivery ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant={deliveryBadgeVariant(webhook.lastDelivery.status)}>
                            {deliveryStatusLabel(webhook.lastDelivery.status, webhook.lastDelivery.lastError)}
                          </Badge>
                          <span className="min-w-0 truncate" title={webhook.lastDelivery.summary}>
                            {webhook.lastDelivery.summary}
                          </span>
                          {lastErrorText ? (
                            <span className="w-full text-xs text-muted-foreground">{lastErrorText}</span>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 gap-1.5 sm:h-7"
                          data-testid={tid.botWebhookTest(webhook.id)}
                          disabled={testingThis}
                          onClick={() => { void handleSendTest(webhook) }}
                        >
                          <Play className="size-3.5" aria-hidden />
                          {testingThis ? "Sending…" : "Send test"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-9 gap-1 text-muted-foreground hover:text-foreground sm:h-7"
                          data-testid={tid.botWebhookDeliveriesToggle(webhook.id)}
                          aria-expanded={deliveriesExpanded}
                          onClick={() =>
                            setExpandedDeliveriesId((current) => (current === webhook.id ? null : webhook.id))
                          }
                        >
                          <ChevronDown
                            aria-hidden
                            className={`size-3.5 transition-transform ${deliveriesExpanded ? "rotate-180" : ""}`}
                          />
                          Deliveries
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto size-9 text-muted-foreground hover:text-foreground sm:size-7"
                          data-testid={tid.botWebhookEdit(webhook.id)}
                          aria-label={`Edit ${webhook.name}`}
                          onClick={() => {
                            setActionError(null)
                            setEditing(webhook)
                          }}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-9 text-muted-foreground hover:text-foreground sm:size-7"
                          data-testid={tid.botWebhookRotate(webhook.id)}
                          aria-label={`Rotate credentials for ${webhook.name}`}
                          onClick={() => {
                            setActionError(null)
                            setConfirmRotate(webhook)
                          }}
                        >
                          <RotateCcw className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-9 text-muted-foreground hover:text-destructive sm:size-7"
                          data-testid={tid.botWebhookDelete(webhook.id)}
                          aria-label={`Delete ${webhook.name}`}
                          onClick={() => {
                            setActionError(null)
                            setConfirmDelete(webhook)
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>

                      {deliveriesExpanded ? (
                        <DeliveriesPanel botId={bot.id} webhookId={webhook.id} />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}

            {actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
          </>
        )}
      </CommunitySheet>

      <ConfirmDialog
        open={Boolean(confirmRotate)}
        onOpenChange={(next) => {
          if (!next && !webhooksApi.updating) setConfirmRotate(null)
        }}
        title={`Rotate credentials for “${confirmRotate?.name ?? "webhook"}”?`}
        description="The current webhook URL and signing secret will stop working immediately. You will need to update the external service with the new credentials."
        confirmLabel="Rotate credentials"
        loadingLabel="Rotating…"
        confirmVariant="destructive"
        loading={webhooksApi.updating}
        onConfirm={async () => {
          if (!confirmRotate || webhooksApi.updating) return
          const target = confirmRotate
          setActionError(null)
          try {
            const rotated = await webhooksApi.updateWebhook(target.id, { rotateCredentials: true })
            setConfirmRotate(null)
            setRevealed({
              heading: "Credentials rotated",
              webhook: rotated.webhook,
              webhookUrl: rotated.webhookUrl,
              signingSecret: rotated.signingSecret ?? null,
            })
          } catch (cause) {
            setConfirmRotate(null)
            if (!isAbortError(cause)) {
              setActionError(getErrorMessage(cause, "Could not rotate credentials. Try again."))
            }
          }
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(next) => {
          if (!next && !webhooksApi.deleting) setConfirmDelete(null)
        }}
        title={`Delete “${confirmDelete?.name ?? "webhook"}”?`}
        description="External services calling this URL will receive 404 immediately and recent delivery logs will be removed."
        confirmLabel="Delete webhook"
        loadingLabel="Deleting…"
        confirmVariant="destructive"
        loading={webhooksApi.deleting}
        onConfirm={async () => {
          if (!confirmDelete || webhooksApi.deleting) return
          const target = confirmDelete
          setActionError(null)
          try {
            await webhooksApi.deleteWebhook(target.id)
            setConfirmDelete(null)
            if (expandedDeliveriesId === target.id) setExpandedDeliveriesId(null)
            toast.success(`Deleted ${target.name}`)
          } catch (cause) {
            setConfirmDelete(null)
            if (!isAbortError(cause)) {
              setActionError(getErrorMessage(cause, "Could not delete this webhook. Try again."))
            }
          }
        }}
      />
    </>
  )
}
