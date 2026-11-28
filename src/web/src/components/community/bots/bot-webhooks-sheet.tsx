"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import {
  BOT_WEBHOOK_MAX_PER_BOT,
  BOT_WEBHOOK_NAME_MAX_LENGTH,
  BOT_WEBHOOK_PROVIDER_META,
  BOT_WEBHOOK_PROVIDERS,
  BOT_WEBHOOK_SECRET_MAX_LENGTH,
  BOT_WEBHOOK_SECRET_MIN_LENGTH,
  BotWebhookCreateSchema,
  BotWebhookUpdateSchema,
  type BotWebhookDelivery,
  type BotWebhookProvider,
  type BotWebhookSummary,
} from "@alook/shared"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
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
import { useBotWebhookDeliveries, useBotWebhooks } from "@/hooks/community/use-bot-webhooks"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { getErrorMessage } from "@/lib/api/client"
import { formatRelativeTime } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { isAbortError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import { EmptyState } from "../empty-state"
import { CommunitySheet } from "../shell/community-sheet"
import { WebhookProviderIcon } from "./webhook-provider-icon"

const control = "h-11 sm:h-8"
const NAMED_PROVIDERS = BOT_WEBHOOK_PROVIDERS.filter((provider) => provider !== "generic")

type SheetView =
  | { kind: "list" }
  | { kind: "choose" }
  | { kind: "create"; provider: BotWebhookProvider }
  | { kind: "edit"; webhook: BotWebhookSummary }

type RevealedCredentials = {
  heading: string
  webhook: BotWebhookSummary
  webhookUrl?: string
  signingSecret: string | null
}

type DoneDialogState = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
}

type ConfirmWebhookDialogState = {
  open: boolean
  webhook: BotWebhookSummary | null
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
    case "event_filtered":
      return null
    default:
      return error
  }
}

function isConnectionHandshake(delivery: Pick<BotWebhookDelivery, "status" | "eventType">): boolean {
  return (
    delivery.status === "ignored" &&
    (delivery.eventType === "ping" || delivery.eventType === "url_verification")
  )
}

function triggerStateNote(
  delivery: Pick<BotWebhookDelivery, "status" | "eventType" | "lastError">,
): string | null {
  if (isConnectionHandshake(delivery)) return "Connected"
  switch (delivery.status) {
    case "dispatched":
      return null
    case "pending":
      return delivery.lastError === "machine_offline" ? "Queued · offline" : "Pending"
    case "ignored":
      return delivery.lastError === "event_filtered" ? "Filtered" : "Skipped"
    case "failed":
      return "Failed"
  }
}

function triggerDotClass(delivery: Pick<BotWebhookDelivery, "status" | "eventType">): string {
  if (isConnectionHandshake(delivery)) return "bg-status-online"
  switch (delivery.status) {
    case "dispatched":
      return "bg-status-online"
    case "failed":
      return "bg-destructive"
    case "pending":
      return "bg-warning"
    case "ignored":
      return "bg-muted-foreground/50"
  }
}

function triggerSubtitle(webhook: BotWebhookSummary): string {
  const meta = BOT_WEBHOOK_PROVIDER_META[webhook.provider]
  const parts: string[] = [meta.label]
  if (webhook.lastTriggeredAt) {
    parts.push(`Last triggered ${formatRelativeTime(webhook.lastTriggeredAt)}`)
  }
  return parts.join(" · ")
}

function SetupStepsList({
  label,
  steps,
}: {
  label: string
  steps: readonly string[]
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-foreground">Connect in {label}</p>
      <ol className="list-decimal space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  )
}

function CopyableWellField({
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
    <div data-slot="invite-link-well" className="space-y-2 rounded-xl p-3">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
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
          variant="ghost"
          className={`${control} shrink-0 gap-1.5 px-3`}
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
  savingSecret,
  onSaveExternalSecret,
  onSendTest,
  onRequestDone,
}: {
  revealed: RevealedCredentials
  testing: boolean
  savingSecret: boolean
  onSaveExternalSecret: (webhookId: string, secret: string) => Promise<void>
  onSendTest: (webhook: BotWebhookSummary) => Promise<void>
  onRequestDone: (needsConfirm: boolean) => void
}) {
  const [externalSecret, setExternalSecret] = useAtom(useCreateAtom(""))
  const [secretError, setSecretError] = useAtom(useCreateAtom<string | null>(null))
  const meta = BOT_WEBHOOK_PROVIDER_META[revealed.webhook.provider]
  const needsExternalSecret = meta.secretMode === "external"
  const hasOneTimeSecret = Boolean(revealed.webhookUrl || revealed.signingSecret)

  return (
    <section className="space-y-6" data-testid={tid.botWebhookCredentialsPanel}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <WebhookProviderIcon provider={revealed.webhook.provider} className="size-5 shrink-0" />
          <h3 className="text-base font-medium">{revealed.heading}</h3>
        </div>
        {hasOneTimeSecret ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {revealed.webhookUrl && revealed.signingSecret
              ? "Copy this link and key now. You cannot view them again after leaving this screen."
              : revealed.webhookUrl
                ? "Copy this link now. You cannot view it again after leaving this screen."
                : "Copy this verification key now. You cannot view it again after leaving this screen."}
          </p>
        ) : null}
      </div>

      <div className="space-y-4">
        {revealed.webhookUrl ? (
          <CopyableWellField
            id="bot-webhook-url"
            label="Trigger link"
            value={revealed.webhookUrl}
            testId={tid.botWebhookUrlValue}
          />
        ) : null}
        {revealed.signingSecret ? (
          <CopyableWellField
            id="bot-webhook-secret"
            label="Verification key"
            value={revealed.signingSecret}
            testId={tid.botWebhookSecretValue}
          />
        ) : null}
      </div>

      {needsExternalSecret ? (
        <div className="space-y-2">
          {revealed.webhook.hasSigningSecret ? (
            <p className="flex items-center gap-2 text-sm text-foreground">
              <Check className="size-4 shrink-0 text-status-online" aria-hidden />
              <span>Verification key saved — {meta.label} triggers are active.</span>
            </p>
          ) : (
            <form
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault()
                if (savingSecret) return
                setSecretError(null)
                const parsed = BotWebhookUpdateSchema.safeParse({ signingSecret: externalSecret })
                if (!parsed.success || !parsed.data.signingSecret) {
                  setSecretError(
                    parsed.error?.issues[0]?.message ??
                      `Key must be at least ${BOT_WEBHOOK_SECRET_MIN_LENGTH} characters.`,
                  )
                  return
                }
                try {
                  await onSaveExternalSecret(revealed.webhook.id, parsed.data.signingSecret)
                  setExternalSecret("")
                } catch (cause) {
                  if (!isAbortError(cause)) {
                    setSecretError(getErrorMessage(cause, "Could not save verification key. Try again."))
                  }
                }
              }}
            >
              <label htmlFor="bot-webhook-external-secret" className="block text-sm font-medium">
                Paste key from {meta.label}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="bot-webhook-external-secret"
                  data-testid={tid.botWebhookExternalSecretInput}
                  type="password"
                  className={`${control} min-w-0 flex-1 font-mono text-xs`}
                  value={externalSecret}
                  onChange={(event) => setExternalSecret(event.target.value)}
                  maxLength={BOT_WEBHOOK_SECRET_MAX_LENGTH}
                  placeholder={meta.secretPlaceholder}
                  autoComplete="new-password"
                  disabled={savingSecret}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  className={`${control} shrink-0 px-3`}
                  data-testid={tid.botWebhookExternalSecretSave}
                  disabled={savingSecret || externalSecret.trim().length === 0}
                >
                  {savingSecret ? "Saving…" : "Save"}
                </Button>
              </div>
              {secretError ? (
                <p role="alert" className="text-xs text-destructive">
                  {secretError}
                </p>
              ) : null}
            </form>
          )}
        </div>
      ) : null}

      <SetupStepsList label={meta.label} steps={meta.setupSteps} />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className={`${control} gap-1.5`}
          disabled={testing}
          onClick={() => { void onSendTest(revealed.webhook) }}
        >
          <Play className="size-3.5" aria-hidden />
          {testing ? "Sending test…" : "Send test"}
        </Button>
        <Button
          type="button"
          className={control}
          onClick={() => onRequestDone(hasOneTimeSecret)}
        >
          Done
        </Button>
      </div>
    </section>
  )
}

function ProviderChooser({
  canGoBack,
  onSelect,
  onCancel,
}: {
  canGoBack: boolean
  onSelect: (provider: BotWebhookProvider) => void
  onCancel: () => void
}) {
  const genericMeta = BOT_WEBHOOK_PROVIDER_META.generic
  return (
    <section className="space-y-4">
      <div className="space-y-2">
        {canGoBack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-9 gap-1 text-muted-foreground hover:text-foreground sm:h-7"
            onClick={onCancel}
          >
            <ChevronLeft className="size-4" aria-hidden />
            Triggers
          </Button>
        ) : null}
        <h3 className="text-base font-medium">Choose a source</h3>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {NAMED_PROVIDERS.map((provider) => {
          const meta = BOT_WEBHOOK_PROVIDER_META[provider]
          return (
            <button
              key={provider}
              type="button"
              data-testid={tid.botWebhookProviderSelect(provider)}
              onClick={() => onSelect(provider)}
              className="flex min-h-11 items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <WebhookProviderIcon provider={provider} className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{meta.label}</span>
            </button>
          )
        })}
      </div>

      <div className="border-t border-border/60 pt-4">
        <button
          type="button"
          data-testid={tid.botWebhookProviderSelect("generic")}
          onClick={() => onSelect("generic")}
          className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <WebhookProviderIcon provider="generic" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">{genericMeta.label}</span>
            <span className="block text-xs text-muted-foreground">{genericMeta.shortDescription}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </div>
    </section>
  )
}

function TriggerForm({
  provider,
  webhook,
  pending,
  onChangeProvider,
  onCancel,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  provider: BotWebhookProvider
  webhook?: BotWebhookSummary
  pending: boolean
  onChangeProvider?: () => void
  onCancel: () => void
  onSubmitCreate: (input: {
    name: string
    provider: BotWebhookProvider
    eventFilter: null
    instruction: string
    requireSecret?: boolean
  }) => Promise<void>
  onSubmitUpdate: (
    webhookId: string,
    input: {
      name: string
      requireSecret?: boolean
      signingSecret?: string
    },
  ) => Promise<void>
}) {
  const meta = BOT_WEBHOOK_PROVIDER_META[provider]
  const defaultName = webhook ? webhook.name : provider === "generic" ? "" : meta.label
  const [name, setName] = useAtom(useCreateAtom(defaultName))
  const [requireSecret, setRequireSecret] = useAtom(useCreateAtom(webhook?.hasSigningSecret ?? false))
  const [externalSecret, setExternalSecret] = useAtom(useCreateAtom(""))
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))

  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault()
        if (pending) return
        setError(null)

        if (webhook) {
          const trimmedSecret = externalSecret.trim()
          const updatePayload = {
            name,
            ...(meta.secretMode === "optional" ? { requireSecret } : {}),
            ...(meta.secretMode === "external" && trimmedSecret.length > 0
              ? { signingSecret: trimmedSecret }
              : {}),
          }
          const parsed = BotWebhookUpdateSchema.safeParse(updatePayload)
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
            return
          }
          try {
            await onSubmitUpdate(webhook.id, {
              name: parsed.data.name ?? name.trim(),
              ...(meta.secretMode === "optional" ? { requireSecret } : {}),
              ...(parsed.data.signingSecret ? { signingSecret: parsed.data.signingSecret } : {}),
            })
          } catch (cause) {
            if (!isAbortError(cause)) {
              setError(getErrorMessage(cause, "Could not update this trigger. Try again."))
            }
          }
          return
        }

        const parsed = BotWebhookCreateSchema.safeParse({
          name,
          provider,
          instruction: "",
          eventFilter: null,
          ...(meta.secretMode === "optional" ? { requireSecret } : {}),
        })
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
          return
        }
        try {
          await onSubmitCreate({
            name: parsed.data.name,
            provider: parsed.data.provider,
            instruction: "",
            eventFilter: null,
            ...(meta.secretMode === "optional" ? { requireSecret } : {}),
          })
        } catch (cause) {
          if (!isAbortError(cause)) {
            setError(getErrorMessage(cause, "Could not create this trigger. Try again."))
          }
        }
      }}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          {!webhook && onChangeProvider ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid={tid.botWebhookChangeProvider}
              aria-label="Choose another source"
              className="-ml-1.5 size-11 text-muted-foreground hover:text-foreground sm:size-7"
              onClick={onChangeProvider}
              disabled={pending}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
          ) : null}
          <WebhookProviderIcon provider={provider} className="size-5 shrink-0" />
          <h3 className="text-base font-medium">
            {webhook ? `Edit ${meta.label} trigger` : `New ${meta.label} trigger`}
          </h3>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{meta.shortDescription}</p>
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
          placeholder={meta.defaultNamePlaceholder}
          autoComplete="off"
          required
          disabled={pending}
        />
      </div>

      {meta.secretMode === "optional" ? (
        <div className="space-y-2">
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 sm:min-h-8">
            <span className="text-sm font-medium">Protect with a key</span>
            <Switch
              data-testid={tid.botWebhookRequireSecret}
              checked={requireSecret}
              onCheckedChange={setRequireSecret}
              disabled={pending}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            {requireSecret
              ? "Callers must include the verification key shown once after saving."
              : webhook
                ? "Anyone with the private trigger link can wake this bot."
                : "Next: Alook creates a private link. Anyone with this link can wake this bot."}
          </p>
        </div>
      ) : meta.secretMode === "external" && webhook ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="bot-webhook-edit-secret" className="block text-sm font-medium">
              {webhook.hasSigningSecret ? "Replace verification key (optional)" : "Verification key"}
            </label>
            <Input
              id="bot-webhook-edit-secret"
              data-testid={tid.botWebhookExternalSecretInput}
              type="password"
              className={`${control} font-mono text-xs`}
              value={externalSecret}
              onChange={(event) => setExternalSecret(event.target.value)}
              maxLength={BOT_WEBHOOK_SECRET_MAX_LENGTH}
              placeholder={
                webhook.hasSigningSecret ? "Leave blank to keep current key" : meta.secretPlaceholder
              }
              autoComplete="new-password"
              disabled={pending}
            />
          </div>
          <SetupStepsList label={meta.label} steps={meta.setupSteps} />
        </div>
      ) : !webhook ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {meta.secretMode === "generated"
            ? `Next: Alook creates a private link and key for you to paste into ${meta.label}.`
            : `Next: Alook creates a private link to paste into ${meta.label}, then you paste back the key ${meta.label} gives you.`}
        </p>
      ) : null}

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
          {pending ? "Saving…" : webhook ? "Save changes" : "Create trigger"}
        </Button>
      </div>
    </form>
  )
}

function TriggerHistoryPanel({
  botId,
  webhookId,
}: {
  botId: string
  webhookId: string
}) {
  const deliveriesQuery = useBotWebhookDeliveries(botId, webhookId, true)
  return (
    <div className="space-y-3 rounded-lg bg-muted/35 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Recent triggers</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label="Refresh history"
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
        <div className="space-y-2" aria-label="Loading trigger history" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : deliveriesQuery.isError ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>Could not load trigger history.</span>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => { void deliveriesQuery.refetch() }}>
            Retry
          </Button>
        </div>
      ) : deliveriesQuery.deliveries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Not triggered yet. Send a test to verify the wake path.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {deliveriesQuery.deliveries.map((delivery: BotWebhookDelivery) => {
            const stateNote = triggerStateNote(delivery)
            const errorDetail = formatDeliveryError(delivery.lastError)
            return (
              <li
                key={delivery.id}
                data-testid={tid.botWebhookDeliveryRow(delivery.id)}
                className="space-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={cn("inline-block size-1.5 shrink-0 rounded-full", triggerDotClass(delivery))}
                  />
                  <span className="font-medium text-foreground">
                    {formatRelativeTime(delivery.createdAt)}
                  </span>
                  {stateNote ? (
                    <span className="text-muted-foreground">{stateNote}</span>
                  ) : null}
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
  return (
    <BotWebhooksSheetContent
      key={`${bot.id}:${open ? "open" : "closed"}`}
      bot={bot}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

function BotWebhooksSheetContent({
  bot,
  open,
  onOpenChange,
}: {
  bot: { id: string; name: string; image?: string | null }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const webhooksApi = useBotWebhooks(bot.id, open)
  const [view, setView] = useAtom(useCreateAtom<SheetView>({ kind: "list" }))
  const [revealed, setRevealed] = useAtom(useCreateAtom<RevealedCredentials | null>(null))
  const [confirmDone, setConfirmDone] = useAtom(
    useCreateAtom<DoneDialogState>({
      open: false,
      title: "Have you saved this link?",
      description: "You cannot view the full link again after leaving this screen.",
      confirmLabel: "I've saved it",
    }),
  )
  const [expandedDeliveriesId, setExpandedDeliveriesId] = useAtom(useCreateAtom<string | null>(null))
  const [confirmRotate, setConfirmRotate] = useAtom(
    useCreateAtom<ConfirmWebhookDialogState>({ open: false, webhook: null }),
  )
  const [confirmDelete, setConfirmDelete] = useAtom(
    useCreateAtom<ConfirmWebhookDialogState>({ open: false, webhook: null }),
  )
  const [actionError, setActionError] = useAtom(useCreateAtom<string | null>(null))

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

  const rotateDialogDescription = (() => {
    const target = confirmRotate.webhook
    if (!target) return ""
    const meta = BOT_WEBHOOK_PROVIDER_META[target.provider]
    if (meta.secretMode === "generated" || (meta.secretMode === "optional" && target.hasSigningSecret)) {
      return "The current link and verification key will stop working right away. Update the other app with the new details."
    }
    if (meta.secretMode === "external" && target.hasSigningSecret) {
      return "The current link will stop working right away. Your saved verification key stays unchanged."
    }
    return "The current link will stop working right away. Update the other app with the new link."
  })()

  return (
    <>
      <CommunitySheet
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmDone((current) => ({ ...current, open: false }))
            setConfirmRotate((current) => ({ ...current, open: false }))
            setConfirmDelete((current) => ({ ...current, open: false }))
          }
          onOpenChange(next)
        }}
        title="Triggers"
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
            key={`${revealed.webhook.id}:${revealed.heading}`}
            revealed={revealed}
            testing={webhooksApi.testingWebhookId === revealed.webhook.id}
            savingSecret={webhooksApi.updating}
            onSaveExternalSecret={async (webhookId, signingSecret) => {
              const updated = await webhooksApi.updateWebhook(webhookId, { signingSecret })
              setRevealed((current) =>
                current && current.webhook.id === webhookId
                  ? { ...current, webhook: updated.webhook }
                  : current,
              )
              toast.success("Verification key saved")
            }}
            onSendTest={handleSendTest}
            onRequestDone={(needsConfirm) => {
              if (!needsConfirm) {
                setRevealed(null)
                return
              }
              if (revealed.webhookUrl && revealed.signingSecret) {
                setConfirmDone({
                  open: true,
                  title: "Have you saved this link and key?",
                  description: "You cannot view the full link or verification key again after leaving this screen.",
                  confirmLabel: "I've saved them",
                })
              } else if (revealed.webhookUrl) {
                setConfirmDone({
                  open: true,
                  title: "Have you saved this link?",
                  description: "You cannot view the full link again after leaving this screen.",
                  confirmLabel: "I've saved it",
                })
              } else {
                setConfirmDone({
                  open: true,
                  title: "Have you saved this key?",
                  description: "You cannot view this verification key again after leaving this screen.",
                  confirmLabel: "I've saved it",
                })
              }
            }}
          />
        ) : view.kind === "choose" ? (
          <ProviderChooser
            canGoBack={webhooksApi.webhooks.length > 0}
            onSelect={(provider) => setView({ kind: "create", provider })}
            onCancel={() => setView({ kind: "list" })}
          />
        ) : view.kind === "create" ? (
          <TriggerForm
            key={`create:${view.provider}`}
            provider={view.provider}
            pending={webhooksApi.creating}
            onChangeProvider={() => setView({ kind: "choose" })}
            onCancel={() => setView({ kind: "list" })}
            onSubmitCreate={async (input) => {
              const created = await webhooksApi.createWebhook(input)
              setView({ kind: "list" })
              setRevealed({
                heading: `${created.webhook.name} is ready`,
                webhook: created.webhook,
                webhookUrl: created.webhookUrl,
                signingSecret: created.signingSecret,
              })
            }}
            onSubmitUpdate={async () => {}}
          />
        ) : view.kind === "edit" ? (
          <TriggerForm
            key={`edit:${view.webhook.id}`}
            provider={view.webhook.provider}
            webhook={view.webhook}
            pending={webhooksApi.updating}
            onCancel={() => setView({ kind: "list" })}
            onSubmitCreate={async () => {}}
            onSubmitUpdate={async (webhookId, input) => {
              const updated = await webhooksApi.updateWebhook(webhookId, input)
              setView({ kind: "list" })
              if (updated.webhookUrl || updated.signingSecret) {
                setRevealed({
                  heading: "Verification key created",
                  webhook: updated.webhook,
                  webhookUrl: updated.webhookUrl,
                  signingSecret: updated.signingSecret ?? null,
                })
              } else {
                toast.success("Trigger updated")
              }
            }}
          />
        ) : (
          <>
            {webhooksApi.isError && webhooksApi.data ? (
              <ConversationResolutionErrorFrame
                as="div"
                title="Could not refresh triggers."
                retrying={webhooksApi.isFetching}
                onRetry={() => { void webhooksApi.refetch() }}
              />
            ) : null}

            {webhooksApi.isPending && !webhooksApi.data ? (
              <div className="space-y-4" aria-label="Loading triggers" role="status">
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
                title="Could not load triggers."
                retrying={webhooksApi.isFetching}
                onRetry={() => { void webhooksApi.refetch() }}
              />
            ) : webhooksApi.webhooks.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center">
                <div className="flex flex-col items-center">
                  <EmptyState
                    icon={Link2}
                    label="No triggers yet"
                    description={`Connect GitHub, Linear, Sentry, or any other app to wake ${bot.name} automatically.`}
                  />
                  <Button
                    type="button"
                    className={`${control} -mt-6 gap-1.5`}
                    data-testid={tid.botWebhooksCreateOpen}
                    onClick={() => {
                      setActionError(null)
                      setView({ kind: "choose" })
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    New trigger
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                    Wake {bot.name} from other apps — never posts to channels.
                  </p>
                  <Button
                    type="button"
                    className={`${control} shrink-0 gap-1.5`}
                    data-testid={tid.botWebhooksCreateOpen}
                    disabled={atLimit}
                    title={atLimit ? `Maximum of ${BOT_WEBHOOK_MAX_PER_BOT} triggers per bot reached.` : undefined}
                    onClick={() => {
                      setActionError(null)
                      setView({ kind: "choose" })
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    New trigger
                  </Button>
                </div>

                <ul className="divide-y divide-border/70">
                  {webhooksApi.webhooks.map((webhook) => {
                    const meta = BOT_WEBHOOK_PROVIDER_META[webhook.provider]
                    const historyExpanded = expandedDeliveriesId === webhook.id
                    const toggling = webhooksApi.togglingWebhookId === webhook.id
                    const testingThis = webhooksApi.testingWebhookId === webhook.id
                    const needsExternalSecret = meta.secretMode === "external" && !webhook.hasSigningSecret
                    return (
                      <li
                        key={webhook.id}
                        data-testid={tid.botWebhookCard(webhook.id)}
                        className="space-y-3 py-4 first:pt-0"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-2.5">
                            <WebhookProviderIcon provider={webhook.provider} className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="min-w-0 wrap-break-word text-sm font-medium text-foreground">
                                  {webhook.name}
                                </h3>
                                {!webhook.enabled ? <Badge variant="outline">Paused</Badge> : null}
                                {needsExternalSecret ? <Badge variant="outline">Finish setup</Badge> : null}
                              </div>
                              <p className="text-xs leading-5 text-muted-foreground">
                                {triggerSubtitle(webhook)}
                              </p>
                            </div>
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
                                  setActionError(getErrorMessage(cause, "Could not update trigger status. Try again."))
                                }
                              }
                            }}
                          />
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          {needsExternalSecret ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-11 gap-1.5 text-foreground sm:h-7"
                              onClick={() => {
                                setActionError(null)
                                setView({ kind: "edit", webhook })
                              }}
                            >
                              <KeyRound className="size-3.5" aria-hidden />
                              Add key
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-11 gap-1.5 text-muted-foreground hover:text-foreground sm:h-7"
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
                            className={cn(
                              "h-11 gap-1 sm:h-7",
                              historyExpanded ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                            )}
                            data-testid={tid.botWebhookDeliveriesToggle(webhook.id)}
                            aria-expanded={historyExpanded}
                            onClick={() =>
                              setExpandedDeliveriesId((current) => (current === webhook.id ? null : webhook.id))
                            }
                          >
                            <ChevronDown
                              aria-hidden
                              className={cn(
                                "size-3.5 transition-transform duration-150",
                                historyExpanded && "rotate-180",
                              )}
                            />
                            History
                          </Button>
                          <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-11 text-muted-foreground hover:text-foreground sm:size-7"
                              data-testid={tid.botWebhookEdit(webhook.id)}
                              aria-label={`Edit ${webhook.name}`}
                              onClick={() => {
                                setActionError(null)
                                setView({ kind: "edit", webhook })
                              }}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-11 text-muted-foreground hover:text-foreground sm:size-7"
                              data-testid={tid.botWebhookRotate(webhook.id)}
                              aria-label={`Reset link for ${webhook.name}`}
                              onClick={() => {
                                setActionError(null)
                                setConfirmRotate({ open: true, webhook })
                              }}
                            >
                              <RotateCcw className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-11 text-muted-foreground hover:text-destructive sm:size-7"
                              data-testid={tid.botWebhookDelete(webhook.id)}
                              aria-label={`Delete ${webhook.name}`}
                              onClick={() => {
                                setActionError(null)
                                setConfirmDelete({ open: true, webhook })
                              }}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </div>

                        {historyExpanded ? (
                          <TriggerHistoryPanel botId={bot.id} webhookId={webhook.id} />
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </>
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
        open={open && confirmDone.open}
        onOpenChange={(next) => setConfirmDone((current) => ({ ...current, open: next }))}
        title={confirmDone.title}
        description={confirmDone.description}
        confirmLabel={confirmDone.confirmLabel}
        confirmVariant="default"
        onConfirm={() => {
          setConfirmDone((current) => ({ ...current, open: false }))
          setRevealed(null)
        }}
      />

      <ConfirmDialog
        open={open && confirmRotate.open}
        onOpenChange={(next) => {
          if (!next && !webhooksApi.updating) {
            setConfirmRotate((current) => ({ ...current, open: false }))
          }
        }}
        title={`Reset link for “${confirmRotate.webhook?.name ?? "trigger"}”?`}
        description={rotateDialogDescription}
        confirmLabel="Reset link"
        loadingLabel="Resetting…"
        confirmVariant="destructive"
        loading={webhooksApi.updating}
        onConfirm={async () => {
          const target = confirmRotate.webhook
          if (!target || webhooksApi.updating) return
          setActionError(null)
          try {
            const rotated = await webhooksApi.updateWebhook(target.id, { rotateCredentials: true })
            setConfirmRotate((current) => ({ ...current, open: false }))
            setRevealed({
              heading: "Link reset",
              webhook: rotated.webhook,
              webhookUrl: rotated.webhookUrl,
              signingSecret: rotated.signingSecret ?? null,
            })
          } catch (cause) {
            setConfirmRotate((current) => ({ ...current, open: false }))
            if (!isAbortError(cause)) {
              setActionError(getErrorMessage(cause, "Could not reset this link. Try again."))
            }
          }
        }}
      />

      <ConfirmDialog
        open={open && confirmDelete.open}
        onOpenChange={(next) => {
          if (!next && !webhooksApi.deleting) {
            setConfirmDelete((current) => ({ ...current, open: false }))
          }
        }}
        title={`Delete “${confirmDelete.webhook?.name ?? "trigger"}”?`}
        description="Requests to this link will stop working right away and recent trigger history will be removed."
        confirmLabel="Delete trigger"
        loadingLabel="Deleting…"
        confirmVariant="destructive"
        loading={webhooksApi.deleting}
        onConfirm={async () => {
          const target = confirmDelete.webhook
          if (!target || webhooksApi.deleting) return
          setActionError(null)
          try {
            await webhooksApi.deleteWebhook(target.id)
            setConfirmDelete((current) => ({ ...current, open: false }))
            if (expandedDeliveriesId === target.id) setExpandedDeliveriesId(null)
            toast.success(`Deleted ${target.name}`)
          } catch (cause) {
            setConfirmDelete((current) => ({ ...current, open: false }))
            if (!isAbortError(cause)) {
              setActionError(getErrorMessage(cause, "Could not delete this trigger. Try again."))
            }
          }
        }}
      />
    </>
  )
}
