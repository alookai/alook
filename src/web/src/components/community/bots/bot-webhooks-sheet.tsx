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
  type BotImAccessPolicy,
  type BotImFeishuRegion,
  type BotTriggerCategory,
  type BotWebhookCreateInput,
  type BotWebhookDelivery,
  type BotWebhookProvider,
  type BotWebhookSummary,
  type BotWebhookUpdateInput,
} from "@alook/shared"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  KeyRound,
  Link2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Trash2,
  UserPlus,
} from "@/components/icons/lucide"
import { toast } from "sonner"
import { AgentAvatar } from "@/components/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  useBotImQrStatus,
  useBotWebhookDeliveries,
  useBotWebhooks,
} from "@/hooks/community/use-bot-webhooks"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { getErrorMessage } from "@/lib/api/client"
import { formatRelativeTime } from "@/lib/community/format-time"
import { encodeQrCode } from "@/lib/community/qr-code"
import { tid } from "@/lib/community/testids"
import { isAbortError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import { EmptyState } from "../empty-state"
import { CommunitySheet } from "../shell/community-sheet"
import { WebhookProviderIcon } from "./webhook-provider-icon"

const control = "h-11 sm:h-8"
const IM_PROVIDERS = BOT_WEBHOOK_PROVIDERS.filter(
  (provider) => BOT_WEBHOOK_PROVIDER_META[provider].category === "im",
)
const WEBHOOK_NAMED_PROVIDERS = BOT_WEBHOOK_PROVIDERS.filter(
  (provider) =>
    BOT_WEBHOOK_PROVIDER_META[provider].category === "webhook" && provider !== "generic",
)

type SheetView =
  | { kind: "list" }
  | { kind: "choose"; category: BotTriggerCategory }
  | { kind: "create"; provider: BotWebhookProvider }
  | { kind: "edit"; webhook: BotWebhookSummary }
  | { kind: "qr"; webhookId: string; fallbackWebhook: BotWebhookSummary }

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
    case "sender_not_allowed":
      return null
    case "mention_required":
      return null
    case "session_expired":
      return "WeChat session expired — re-scan QR to reconnect"
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
  delivery: Pick<BotWebhookDelivery, "direction" | "status" | "eventType" | "lastError">,
): string | null {
  if (delivery.direction === "outbound") {
    return delivery.status === "failed" ? "Reply failed" : "Replied"
  }
  if (isConnectionHandshake(delivery)) return "Connected"
  switch (delivery.status) {
    case "dispatched":
      return null
    case "pending":
      return delivery.lastError === "machine_offline" ? "Queued · offline" : "Pending"
    case "blocked":
      return "Blocked · not allowed"
    case "ignored":
      if (delivery.lastError === "mention_required") return "Ignored · no @mention"
      return delivery.lastError === "event_filtered" ? "Filtered" : "Skipped"
    case "failed":
      return "Failed"
  }
}

function triggerDotClass(
  delivery: Pick<BotWebhookDelivery, "direction" | "status" | "eventType">,
): string {
  if (delivery.direction === "outbound") {
    return delivery.status === "failed" ? "bg-destructive" : "bg-status-online"
  }
  if (isConnectionHandshake(delivery)) return "bg-status-online"
  switch (delivery.status) {
    case "dispatched":
      return "bg-status-online"
    case "failed":
      return "bg-destructive"
    case "pending":
      return "bg-warning"
    case "blocked":
    case "ignored":
      return "bg-muted-foreground/50"
  }
}

function triggerSubtitle(webhook: BotWebhookSummary): string {
  const meta = BOT_WEBHOOK_PROVIDER_META[webhook.provider]
  if (webhook.category === "im") {
    const parts: string[] = []
    if (webhook.provider === "feishu") {
      parts.push(webhook.region === "global" ? "Lark" : "Feishu")
    } else {
      parts.push(meta.label)
    }
    if (webhook.provider === "telegram" && webhook.botUsername) {
      parts.push(`@${webhook.botUsername.replace(/^@/, "")}`)
    }
    if (webhook.provider === "wechat") {
      parts.push("1:1 DM only")
      if (webhook.botAccountLabel) parts.push(webhook.botAccountLabel)
      if (webhook.machineName) parts.push(`via ${webhook.machineName}`)
    } else {
      parts.push(webhook.requireMentionInGroups ? "DM & @mentions" : "DM & groups")
    }
    if (webhook.lastTriggeredAt) {
      parts.push(`Last message ${formatRelativeTime(webhook.lastTriggeredAt)}`)
    }
    return parts.join(" · ")
  }
  const parts: string[] = [meta.label]
  if (webhook.lastTriggeredAt) {
    parts.push(`Last triggered ${formatRelativeTime(webhook.lastTriggeredAt)}`)
  }
  return parts.join(" · ")
}

function parseAllowedSendersInput(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ]
}

function TriggerStatusBadge({ webhook }: { webhook: BotWebhookSummary }) {
  switch (webhook.connectionStatus) {
    case "connected":
      return webhook.category === "im" ? (
        <span
          aria-label="Connected"
          title="Connected"
          className="inline-block size-2 shrink-0 rounded-full bg-status-online"
        />
      ) : null
    case "paused":
      return <Badge variant="outline">Paused</Badge>
    case "setup_required":
      return <Badge variant="outline">Finish setup</Badge>
    case "scan_required":
      return <Badge variant="outline">Scan to connect</Badge>
    case "session_expired":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-warning" />
          <span>Session expired</span>
        </span>
      )
    case "machine_offline":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-warning" />
          <span>Machine offline</span>
        </span>
      )
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-destructive" />
          <span>Error</span>
        </span>
      )
  }
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
  const isIm = revealed.webhook.category === "im"
  const needsExternalSecret = !isIm && meta.secretMode === "external"
  const hasOneTimeSecret = Boolean(revealed.webhookUrl || revealed.signingSecret)
  const urlLabel =
    revealed.webhook.provider === "feishu"
      ? "Event Callback URL"
      : revealed.webhook.provider === "slack"
        ? "Event Request URL"
        : "Trigger link"

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
            label={urlLabel}
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
        {!isIm ? (
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
        ) : null}
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
  category,
  canGoBack,
  onSelect,
  onCancel,
}: {
  category: BotTriggerCategory
  canGoBack: boolean
  onSelect: (provider: BotWebhookProvider) => void
  onCancel: () => void
}) {
  if (category === "im") {
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
          <h3 className="text-base font-medium">Connect an IM platform</h3>
        </div>

        <div className="space-y-2">
          {IM_PROVIDERS.map((provider) => {
            const meta = BOT_WEBHOOK_PROVIDER_META[provider]
            return (
              <button
                key={provider}
                type="button"
                data-testid={tid.botWebhookProviderSelect(provider)}
                onClick={() => onSelect(provider)}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <WebhookProviderIcon provider={provider} className="size-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{meta.label}</span>
                  <span className="block text-xs text-muted-foreground">{meta.shortDescription}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            )
          })}
        </div>
      </section>
    )
  }

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
        {WEBHOOK_NAMED_PROVIDERS.map((provider) => {
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

function WeChatQrPanel({
  botId,
  webhook,
  starting,
  onStartQr,
  onBack,
}: {
  botId: string
  webhook: BotWebhookSummary
  starting: boolean
  onStartQr: (triggerId: string) => Promise<void>
  onBack: () => void
}) {
  const qrQuery = useBotImQrStatus(botId, webhook.id, true)
  const [startError, setStartError] = useAtom(useCreateAtom<string | null>(null))
  const qrState = qrQuery.qrState
  const machineLabel = webhook.machineName ?? "your machine"
  const isOffline = webhook.machineOnline === false

  const qrStatus = qrState?.qrStatus ?? (webhook.connectionStatus === "connected" ? "confirmed" : "idle")
  const qrUrl = qrState?.qrUrl ?? null
  const accountLabel = qrState?.botAccountLabel ?? webhook.botAccountLabel
  const errorText = startError ?? qrState?.error ?? (webhook.connectionStatus === "error" ? webhook.daemonLastError : null)

  let qrMatrix: ReturnType<typeof encodeQrCode> | null = null
  if (qrUrl && (qrStatus === "pending" || qrStatus === "scanned")) {
    try {
      qrMatrix = encodeQrCode(qrUrl)
    } catch {
      qrMatrix = null
    }
  }

  const triggerGenerate = async () => {
    setStartError(null)
    try {
      await onStartQr(webhook.id)
    } catch (cause) {
      if (!isAbortError(cause)) {
        setStartError(getErrorMessage(cause, "Could not generate a WeChat QR code. Try again."))
      }
    }
  }

  return (
    <section className="space-y-6" data-testid={tid.botImQrPanel}>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to Triggers"
            className="-ml-1.5 size-11 text-muted-foreground hover:text-foreground sm:size-7"
            onClick={onBack}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <WebhookProviderIcon provider="wechat" className="size-5 shrink-0" />
          <h3 className="text-base font-medium">{webhook.name}</h3>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Runs on {machineLabel} while online. Supports 1:1 DMs only — WeChat iLink bots cannot join group chats.
        </p>
      </div>

      {isOffline ? (
        <div className="space-y-4">
          <p className="text-sm text-warning" data-testid={tid.botImQrStatus}>
            Start {machineLabel} to link WeChat.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className={control} onClick={onBack}>
              Back
            </Button>
            <Button
              type="button"
              className={control}
              data-testid={tid.botImQrGenerate}
              disabled
            >
              Generate QR code
            </Button>
          </div>
        </div>
      ) : starting ? (
        <div className="flex flex-col items-center gap-3 py-4" data-testid={tid.botImQrStatus}>
          <Skeleton className="size-50 rounded-xl" aria-label="Generating QR code" />
          <p className="text-xs text-muted-foreground">Requesting WeChat QR code from {machineLabel}…</p>
        </div>
      ) : qrStatus === "confirmed" ? (
        <div className="space-y-5 py-2" data-testid={tid.botImQrStatus}>
          <div className="flex items-center gap-2.5 text-sm font-medium text-foreground">
            <CircleCheck className="size-5 shrink-0 text-status-online" aria-hidden />
            <span>Connected via {machineLabel}</span>
          </div>
          {accountLabel ? (
            <p className="font-mono text-xs text-muted-foreground">{accountLabel}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className={control} onClick={() => { void triggerGenerate() }}>
              Re-scan QR
            </Button>
            <Button type="button" className={control} onClick={onBack}>
              Done
            </Button>
          </div>
        </div>
      ) : qrStatus === "pending" || qrStatus === "scanned" ? (
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="relative inline-flex items-center justify-center rounded-xl bg-white p-3 shadow-xs">
            {qrMatrix ? (
              <svg
                data-testid={tid.botImQrSvg}
                role="img"
                aria-label="WeChat login QR code"
                viewBox={`0 0 ${qrMatrix.size} ${qrMatrix.size}`}
                width={200}
                height={200}
                shapeRendering="crispEdges"
                className={cn(qrStatus === "scanned" && "opacity-35")}
              >
                <rect width={qrMatrix.size} height={qrMatrix.size} fill="#FFFFFF" />
                <path d={qrMatrix.pathData} fill="#000000" />
              </svg>
            ) : (
              <div className="flex size-50 items-center justify-center text-center text-xs text-neutral-700">
                QR code unavailable — open link on phone
              </div>
            )}
            {qrStatus === "scanned" ? (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
                <span className="rounded-lg bg-neutral-950/90 px-3 py-1.5 text-xs font-medium text-white">
                  Scanned — confirm on phone
                </span>
              </div>
            ) : null}
          </div>
          <p className="text-center text-xs text-muted-foreground" data-testid={tid.botImQrStatus}>
            {qrStatus === "scanned"
              ? "Scanned — confirm login on your phone."
              : "Scan with WeChat on your phone."}
          </p>
          <div className="flex w-full justify-end gap-2">
            <Button type="button" variant="ghost" className={control} onClick={onBack}>
              Later
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={control}
              data-testid={tid.botImQrGenerate}
              onClick={() => { void triggerGenerate() }}
            >
              Refresh QR
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {qrStatus === "expired" ? (
            <p className="text-sm text-warning" data-testid={tid.botImQrStatus}>
              {errorText || "QR code expired. Generate a new code to link WeChat."}
            </p>
          ) : errorText ? (
            <p role="alert" className="text-sm text-destructive" data-testid={tid.botImQrStatus}>
              {errorText}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid={tid.botImQrStatus}>
              Generate a QR code and scan it with WeChat on your phone.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className={control} onClick={onBack}>
              Back
            </Button>
            <Button
              type="button"
              className={control}
              data-testid={tid.botImQrGenerate}
              onClick={() => { void triggerGenerate() }}
            >
              {qrStatus === "expired" || errorText ? "Generate new QR" : "Generate QR code"}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function TriggerForm({
  botName,
  provider,
  webhook,
  pending,
  onChangeProvider,
  onCancel,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  botName: string
  provider: BotWebhookProvider
  webhook?: BotWebhookSummary
  pending: boolean
  onChangeProvider?: () => void
  onCancel: () => void
  onSubmitCreate: (input: BotWebhookCreateInput) => Promise<void>
  onSubmitUpdate: (webhookId: string, input: BotWebhookUpdateInput) => Promise<void>
}) {
  const meta = BOT_WEBHOOK_PROVIDER_META[provider]
  const isIm = meta.category === "im"
  const defaultName = webhook
    ? webhook.name
    : provider === "generic"
      ? ""
      : provider === "feishu"
        ? "Feishu"
        : meta.label

  const [name, setName] = useAtom(useCreateAtom(defaultName))
  const [requireSecret, setRequireSecret] = useAtom(useCreateAtom(webhook?.hasSigningSecret ?? false))
  const [externalSecret, setExternalSecret] = useAtom(useCreateAtom(""))
  const [botToken, setBotToken] = useAtom(useCreateAtom(""))
  const [feishuRegion, setFeishuRegion] = useAtom(
    useCreateAtom<BotImFeishuRegion>(webhook?.region ?? "cn"),
  )
  const [feishuAppId, setFeishuAppId] = useAtom(useCreateAtom(webhook?.feishuAppId ?? ""))
  const [feishuAppSecret, setFeishuAppSecret] = useAtom(useCreateAtom(""))
  const [feishuVerificationToken, setFeishuVerificationToken] = useAtom(useCreateAtom(""))
  const [feishuEncryptKey, setFeishuEncryptKey] = useAtom(useCreateAtom(""))
  const [accessPolicy, setAccessPolicy] = useAtom(
    useCreateAtom<BotImAccessPolicy>(webhook?.accessPolicy ?? "allowlist"),
  )
  const [allowedSendersText, setAllowedSendersText] = useAtom(
    useCreateAtom((webhook?.allowedSenders ?? []).join("\n")),
  )
  const [requireMentionInGroups, setRequireMentionInGroups] = useAtom(
    useCreateAtom(webhook?.requireMentionInGroups ?? true),
  )
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))

  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault()
        if (pending) return
        setError(null)

        const trimmedSecret = externalSecret.trim()
        const trimmedBotToken = botToken.trim()
        const trimmedAppId = feishuAppId.trim()
        const trimmedAppSecret = feishuAppSecret.trim()
        const trimmedVerifyToken = feishuVerificationToken.trim()
        const trimmedEncryptKey = feishuEncryptKey.trim()
        const allowedSenders = isIm ? parseAllowedSendersInput(allowedSendersText) : undefined

        if (!webhook && isIm) {
          if (provider === "telegram" && !trimmedBotToken) {
            setError("Bot Token is required.")
            return
          }
          if (provider === "feishu" && (!trimmedAppId || !trimmedAppSecret)) {
            setError("App ID and App Secret are required.")
            return
          }
          if (provider === "slack") {
            if (!trimmedSecret) {
              setError("Slack Signing Secret is required.")
              return
            }
            if (!trimmedBotToken) {
              setError("Slack Bot User OAuth Token (xoxb-...) is required.")
              return
            }
          }
        }

        if (webhook) {
          const updatePayload: BotWebhookUpdateInput = {
            name,
            ...(meta.secretMode === "optional" ? { requireSecret } : {}),
            ...((meta.secretMode === "external" || provider === "slack") && trimmedSecret.length > 0
              ? { signingSecret: trimmedSecret }
              : {}),
            ...((provider === "telegram" || provider === "slack") && trimmedBotToken.length > 0
              ? { botToken: trimmedBotToken }
              : {}),
            ...(provider === "feishu"
              ? {
                  feishuRegion,
                  ...(trimmedAppId.length > 0 ? { feishuAppId: trimmedAppId } : {}),
                  ...(trimmedAppSecret.length > 0 ? { feishuAppSecret: trimmedAppSecret } : {}),
                  ...(trimmedVerifyToken.length > 0 ? { feishuVerificationToken: trimmedVerifyToken } : {}),
                  ...(trimmedEncryptKey.length > 0 ? { feishuEncryptKey: trimmedEncryptKey } : {}),
                }
              : {}),
            ...(isIm
              ? {
                  accessPolicy,
                  allowedSenders,
                  ...(meta.supportsGroups ? { requireMentionInGroups } : {}),
                }
              : {}),
          }
          const parsed = BotWebhookUpdateSchema.safeParse(updatePayload)
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
            return
          }
          try {
            await onSubmitUpdate(webhook.id, parsed.data)
          } catch (cause) {
            if (!isAbortError(cause)) {
              setError(getErrorMessage(cause, "Could not update this trigger. Try again."))
            }
          }
          return
        }

        const createPayload = {
          name,
          provider,
          instruction: "",
          eventFilter: null,
          ...(meta.secretMode === "optional" ? { requireSecret } : {}),
          ...(provider === "slack"
            ? { signingSecret: trimmedSecret, botToken: trimmedBotToken }
            : {}),
          ...(provider === "telegram" ? { botToken: trimmedBotToken } : {}),
          ...(provider === "feishu"
            ? {
                feishuRegion,
                feishuAppId: trimmedAppId,
                feishuAppSecret: trimmedAppSecret,
                ...(trimmedVerifyToken.length > 0 ? { feishuVerificationToken: trimmedVerifyToken } : {}),
                ...(trimmedEncryptKey.length > 0 ? { feishuEncryptKey: trimmedEncryptKey } : {}),
              }
            : {}),
          ...(isIm
            ? {
                accessPolicy,
                allowedSenders,
                ...(meta.supportsGroups ? { requireMentionInGroups } : {}),
              }
            : {}),
        }
        const parsed = BotWebhookCreateSchema.safeParse(createPayload)
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.")
          return
        }
        try {
          await onSubmitCreate(parsed.data)
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
            {webhook
              ? `Edit ${meta.label}`
              : isIm
                ? `Connect ${meta.label}`
                : `New ${meta.label} trigger`}
          </h3>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {provider === "wechat"
            ? "Runs on your bot's machine while online. Supports 1:1 DMs only — WeChat iLink bots cannot join group chats."
            : meta.shortDescription}
        </p>
      </div>

      {provider === "feishu" ? (
        <div className="space-y-2">
          <span className="block text-sm font-medium">Region</span>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
            {(
              [
                { value: "cn", label: "Feishu (CN)" },
                { value: "global", label: "Lark (Global)" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={tid.botImFeishuRegion(option.value)}
                onClick={() => setFeishuRegion(option.value)}
                disabled={pending}
                className={cn(
                  "min-h-9 rounded-md px-3 text-xs font-medium transition-colors sm:min-h-7",
                  feishuRegion === option.value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

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

      {provider === "telegram" ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <label htmlFor="bot-im-telegram-token" className="block text-sm font-medium">
              {webhook?.hasOutboundCredentials ? "Replace Bot Token (optional)" : "Bot Token"}
            </label>
            <Input
              id="bot-im-telegram-token"
              data-testid={tid.botImBotTokenInput}
              type="password"
              className={`${control} font-mono text-xs`}
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder={
                webhook?.hasOutboundCredentials ? "Leave blank to keep current token" : "123456789:AA..."
              }
              autoComplete="new-password"
              required={!webhook}
              disabled={pending}
            />
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              How to get a Telegram Bot Token
            </summary>
            <div className="pt-2">
              <SetupStepsList label="Telegram" steps={meta.setupSteps} />
            </div>
          </details>
        </div>
      ) : provider === "feishu" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="bot-im-feishu-appid" className="block text-sm font-medium">
              App ID
            </label>
            <Input
              id="bot-im-feishu-appid"
              data-testid={tid.botImFeishuAppIdInput}
              className={`${control} font-mono text-xs`}
              value={feishuAppId}
              onChange={(event) => setFeishuAppId(event.target.value)}
              placeholder="cli_a1b2c3d4e5f6"
              autoComplete="off"
              required={!webhook}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="bot-im-feishu-secret" className="block text-sm font-medium">
              {webhook?.hasOutboundCredentials ? "Replace App Secret (optional)" : "App Secret"}
            </label>
            <Input
              id="bot-im-feishu-secret"
              data-testid={tid.botImFeishuAppSecretInput}
              type="password"
              className={`${control} font-mono text-xs`}
              value={feishuAppSecret}
              onChange={(event) => setFeishuAppSecret(event.target.value)}
              placeholder={
                webhook?.hasOutboundCredentials
                  ? "Leave blank to keep current secret"
                  : "Paste Feishu App Secret"
              }
              autoComplete="new-password"
              required={!webhook}
              disabled={pending}
            />
          </div>
          <details className="space-y-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              Event verification & encryption (optional)
            </summary>
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <label htmlFor="bot-im-feishu-verify" className="block text-xs font-medium text-foreground">
                  Verification Token
                </label>
                <Input
                  id="bot-im-feishu-verify"
                  data-testid={tid.botImFeishuVerificationTokenInput}
                  type="password"
                  className={`${control} font-mono text-xs`}
                  value={feishuVerificationToken}
                  onChange={(event) => setFeishuVerificationToken(event.target.value)}
                  placeholder="Optional Verification Token"
                  autoComplete="new-password"
                  disabled={pending}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bot-im-feishu-encrypt" className="block text-xs font-medium text-foreground">
                  Encrypt Key
                </label>
                <Input
                  id="bot-im-feishu-encrypt"
                  data-testid={tid.botImFeishuEncryptKeyInput}
                  type="password"
                  className={`${control} font-mono text-xs`}
                  value={feishuEncryptKey}
                  onChange={(event) => setFeishuEncryptKey(event.target.value)}
                  placeholder="Optional Encrypt Key"
                  autoComplete="new-password"
                  disabled={pending}
                />
              </div>
            </div>
          </details>
          {!webhook ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Next: Alook creates an Event Callback URL for you to paste into Feishu Open Platform.
            </p>
          ) : (
            <SetupStepsList label={meta.label} steps={meta.setupSteps} />
          )}
        </div>
      ) : provider === "slack" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="bot-im-slack-signing" className="block text-sm font-medium">
              {webhook?.hasSigningSecret ? "Replace Signing Secret (optional)" : "Signing Secret"}
            </label>
            <Input
              id="bot-im-slack-signing"
              data-testid={tid.botWebhookExternalSecretInput}
              type="password"
              className={`${control} font-mono text-xs`}
              value={externalSecret}
              onChange={(event) => setExternalSecret(event.target.value)}
              maxLength={BOT_WEBHOOK_SECRET_MAX_LENGTH}
              placeholder={
                webhook?.hasSigningSecret
                  ? "Leave blank to keep current secret"
                  : meta.secretPlaceholder
              }
              autoComplete="new-password"
              required={!webhook}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="bot-im-slack-token" className="block text-sm font-medium">
              {webhook?.hasOutboundCredentials
                ? "Replace Bot User OAuth Token (optional)"
                : "Bot User OAuth Token (xoxb-...)"}
            </label>
            <Input
              id="bot-im-slack-token"
              data-testid={tid.botImBotTokenInput}
              type="password"
              className={`${control} font-mono text-xs`}
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder={
                webhook?.hasOutboundCredentials
                  ? "Leave blank to keep current token"
                  : "xoxb-..."
              }
              autoComplete="new-password"
              required={!webhook}
              disabled={pending}
            />
          </div>
          {!webhook ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Next: Alook creates an Event Request URL to paste into Slack Event Subscriptions.
            </p>
          ) : (
            <SetupStepsList label="Slack" steps={meta.setupSteps} />
          )}
        </div>
      ) : provider === "wechat" ? null : meta.secretMode === "optional" ? (
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

      {isIm ? (
        <div className="space-y-4 border-t border-border/60 pt-4">
          <div className="space-y-2">
            <span className="block text-sm font-medium">Who can reach {botName}</span>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
              {(
                [
                  { value: "allowlist", label: "Allowed senders only" },
                  { value: "anyone", label: "Anyone" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-testid={tid.botImAccessPolicy(option.value)}
                  onClick={() => setAccessPolicy(option.value)}
                  disabled={pending}
                  className={cn(
                    "min-h-9 rounded-md px-2.5 text-xs font-medium transition-colors sm:min-h-7",
                    accessPolicy === option.value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {accessPolicy === "anyone" ? (
              <p className="text-xs leading-5 text-warning">
                Anyone who finds this bot can wake it and run tasks on your machine.
              </p>
            ) : (
              <div className="space-y-1.5 pt-1">
                <label htmlFor="bot-im-allowed-senders" className="block text-xs font-medium text-muted-foreground">
                  Allowed sender IDs (optional)
                </label>
                <textarea
                  id="bot-im-allowed-senders"
                  data-testid={tid.botImAllowedSendersInput}
                  rows={2}
                  value={allowedSendersText}
                  onChange={(event) => setAllowedSendersText(event.target.value)}
                  placeholder="One sender ID per line, or leave empty"
                  disabled={pending}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Or message your bot first, then click Allow on the blocked entry in History.
                </p>
              </div>
            )}
          </div>

          {meta.supportsGroups ? (
            <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 sm:min-h-8">
              <span className="text-sm font-medium">Only respond when @mentioned in groups</span>
              <Switch
                data-testid={tid.botImRequireMention}
                checked={requireMentionInGroups}
                onCheckedChange={setRequireMentionInGroups}
                disabled={pending}
              />
            </label>
          ) : null}
        </div>
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
          {pending
            ? "Saving…"
            : webhook
              ? "Save changes"
              : provider === "wechat"
                ? "Continue to QR"
                : isIm
                  ? `Connect ${meta.label}`
                  : "Create trigger"}
        </Button>
      </div>
    </form>
  )
}

function TriggerHistoryPanel({
  botId,
  webhook,
  allowingSenderKey,
  onAllowSender,
}: {
  botId: string
  webhook: BotWebhookSummary
  allowingSenderKey: string | null
  onAllowSender: (webhook: BotWebhookSummary, senderId: string) => Promise<void>
}) {
  const deliveriesQuery = useBotWebhookDeliveries(botId, webhook.id, true)
  const meta = BOT_WEBHOOK_PROVIDER_META[webhook.provider]
  const isIm = webhook.category === "im"

  return (
    <div className="space-y-3 rounded-lg bg-muted/35 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {isIm ? "Recent messages" : "Recent triggers"}
        </span>
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
        <p className="text-xs text-muted-foreground">
          {isIm
            ? `No messages yet. Message your bot in ${meta.label} to verify the connection.`
            : "Not triggered yet. Send a test to verify the wake path."}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {deliveriesQuery.deliveries.map((delivery: BotWebhookDelivery) => {
            const stateNote = triggerStateNote(delivery)
            const errorDetail = formatDeliveryError(delivery.lastError)
            const senderId = delivery.senderId?.trim() || null
            const canAllow =
              isIm &&
              delivery.status === "blocked" &&
              Boolean(senderId) &&
              !webhook.allowedSenders.includes(senderId!)
            const alreadyAllowed =
              isIm &&
              delivery.status === "blocked" &&
              Boolean(senderId) &&
              webhook.allowedSenders.includes(senderId!)
            const allowingThis = senderId ? allowingSenderKey === `${webhook.id}:${senderId}` : false
            const actorHeader = [delivery.chatLabel, delivery.senderLabel].filter(Boolean).join(" · ")
            return (
              <li
                key={delivery.id}
                data-testid={tid.botWebhookDeliveryRow(delivery.id)}
                className="space-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("inline-block size-1.5 shrink-0 rounded-full", triggerDotClass(delivery))}
                    />
                    <span className="shrink-0 font-medium text-foreground">
                      {formatRelativeTime(delivery.createdAt)}
                    </span>
                    {stateNote ? (
                      <span className="truncate text-muted-foreground">{stateNote}</span>
                    ) : null}
                  </div>
                  {canAllow && senderId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2 text-xs text-foreground"
                      data-testid={tid.botImAllowSender(delivery.id)}
                      disabled={allowingThis}
                      onClick={() => { void onAllowSender(webhook, senderId) }}
                    >
                      <UserPlus className="size-3.5" aria-hidden />
                      {allowingThis ? "Allowing…" : "Allow"}
                    </Button>
                  ) : alreadyAllowed ? (
                    <span className="shrink-0 text-[11px] text-status-online">Allowed</span>
                  ) : null}
                </div>
                {actorHeader ? (
                  <p className="truncate text-xs font-medium text-foreground/85">{actorHeader}</p>
                ) : null}
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
  const [selectedTab, setSelectedTab] = useAtom(useCreateAtom<BotTriggerCategory | null>(null))
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

  const imTriggers = webhooksApi.webhooks.filter((item) => item.category === "im")
  const webhookTriggers = webhooksApi.webhooks.filter((item) => item.category === "webhook")
  const activeTab: BotTriggerCategory =
    selectedTab ??
    (imTriggers.length > 0 ? "im" : webhookTriggers.length > 0 ? "webhook" : "im")
  const visibleTriggers = activeTab === "im" ? imTriggers : webhookTriggers
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

  const handleAllowSender = async (webhook: BotWebhookSummary, senderId: string) => {
    setActionError(null)
    try {
      await webhooksApi.allowSender(webhook.id, senderId)
      toast.success("Sender allowed")
    } catch (cause) {
      if (!isAbortError(cause)) {
        setActionError(getErrorMessage(cause, "Could not allow this sender. Try again."))
      }
    }
  }

  const rotateDialogDescription = (() => {
    const target = confirmRotate.webhook
    if (!target) return ""
    if (target.provider === "telegram") {
      return "Alook will rotate the webhook link and secret token and re-register them with Telegram automatically."
    }
    const meta = BOT_WEBHOOK_PROVIDER_META[target.provider]
    if (meta.secretMode === "generated" || (meta.secretMode === "optional" && target.hasSigningSecret)) {
      return "The current link and verification key will stop working right away. Update the other app with the new details."
    }
    if ((meta.secretMode === "external" || target.category === "im") && target.hasSigningSecret) {
      return "The current link will stop working right away. Your saved credentials stay unchanged."
    }
    return "The current link will stop working right away. Update the other app with the new link."
  })()

  const activeQrWebhook =
    view.kind === "qr"
      ? (webhooksApi.webhooks.find((item) => item.id === view.webhookId) ?? view.fallbackWebhook)
      : null

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
        ) : view.kind === "qr" && activeQrWebhook ? (
          <WeChatQrPanel
            key={`qr:${activeQrWebhook.id}`}
            botId={bot.id}
            webhook={activeQrWebhook}
            starting={webhooksApi.startingQrTriggerId === activeQrWebhook.id}
            onStartQr={async (triggerId) => {
              await webhooksApi.startImQr(triggerId)
            }}
            onBack={() => setView({ kind: "list" })}
          />
        ) : view.kind === "choose" ? (
          <ProviderChooser
            category={view.category}
            canGoBack
            onSelect={(provider) => setView({ kind: "create", provider })}
            onCancel={() => setView({ kind: "list" })}
          />
        ) : view.kind === "create" ? (
          <TriggerForm
            key={`create:${view.provider}`}
            botName={bot.name}
            provider={view.provider}
            pending={webhooksApi.creating}
            onChangeProvider={() =>
              setView({
                kind: "choose",
                category: BOT_WEBHOOK_PROVIDER_META[view.provider].category,
              })
            }
            onCancel={() => setView({ kind: "list" })}
            onSubmitCreate={async (input) => {
              const created = await webhooksApi.createWebhook(input)
              setSelectedTab(created.webhook.category)
              if (created.webhook.provider === "wechat") {
                setView({ kind: "qr", webhookId: created.webhook.id, fallbackWebhook: created.webhook })
                if (created.webhook.machineOnline !== false) {
                  void webhooksApi.startImQr(created.webhook.id).catch(() => undefined)
                }
                return
              }
              setView({ kind: "list" })
              if (created.webhook.provider === "telegram") {
                const handle = created.webhook.botUsername
                  ? `@${created.webhook.botUsername.replace(/^@/, "")}`
                  : created.webhook.name
                toast.success(`Connected as ${handle}`)
              } else if (created.webhookUrl || created.signingSecret) {
                setRevealed({
                  heading: `${created.webhook.name} is ready`,
                  webhook: created.webhook,
                  webhookUrl: created.webhookUrl,
                  signingSecret: created.signingSecret,
                })
              } else {
                toast.success(`${created.webhook.name} connected`)
              }
            }}
            onSubmitUpdate={async () => {}}
          />
        ) : view.kind === "edit" ? (
          <TriggerForm
            key={`edit:${view.webhook.id}`}
            botName={bot.name}
            provider={view.webhook.provider}
            webhook={view.webhook}
            pending={webhooksApi.updating}
            onCancel={() => setView({ kind: "list" })}
            onSubmitCreate={async () => {}}
            onSubmitUpdate={async (webhookId, input) => {
              const updated = await webhooksApi.updateWebhook(webhookId, input)
              setView({ kind: "list" })
              if (updated.webhook.provider !== "telegram" && (updated.webhookUrl || updated.signingSecret)) {
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
            ) : (
              <>
                <div
                  role="tablist"
                  aria-label="Trigger categories"
                  className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1"
                >
                  {(
                    [
                      { id: "im", label: "IM", count: imTriggers.length },
                      { id: "webhook", label: "Webhooks", count: webhookTriggers.length },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      data-testid={tid.botTriggersTab(tab.id)}
                      onClick={() => {
                        setActionError(null)
                        setSelectedTab(tab.id)
                      }}
                      className={cn(
                        "min-h-9 rounded-md px-3 text-xs font-medium transition-colors sm:min-h-7",
                        activeTab === tab.id
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.count > 0 ? `${tab.label} · ${tab.count}` : tab.label}
                    </button>
                  ))}
                </div>

                {visibleTriggers.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center">
                    <div className="flex flex-col items-center">
                      <EmptyState
                        icon={activeTab === "im" ? MessageSquare : Link2}
                        label={activeTab === "im" ? "No IM channels yet" : "No webhooks yet"}
                        description={
                          activeTab === "im"
                            ? `Connect Telegram, Feishu, Slack, or WeChat to chat with ${bot.name}.`
                            : `Connect GitHub, Linear, Sentry, or any other app to wake ${bot.name} automatically.`
                        }
                      />
                      <Button
                        type="button"
                        className={`${control} -mt-6 gap-1.5`}
                        data-testid={tid.botWebhooksCreateOpen}
                        disabled={atLimit}
                        title={atLimit ? `Maximum of ${BOT_WEBHOOK_MAX_PER_BOT} triggers per bot reached.` : undefined}
                        onClick={() => {
                          setActionError(null)
                          setView({ kind: "choose", category: activeTab })
                        }}
                      >
                        <Plus className="size-4" aria-hidden />
                        {activeTab === "im" ? "Connect IM" : "New webhook"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                        {activeTab === "im"
                          ? `Chat with ${bot.name} from Telegram, Feishu, Slack, or WeChat.`
                          : `Wake ${bot.name} from other apps — never posts to channels.`}
                      </p>
                      <Button
                        type="button"
                        className={`${control} shrink-0 gap-1.5`}
                        data-testid={tid.botWebhooksCreateOpen}
                        disabled={atLimit}
                        title={atLimit ? `Maximum of ${BOT_WEBHOOK_MAX_PER_BOT} triggers per bot reached.` : undefined}
                        onClick={() => {
                          setActionError(null)
                          setView({ kind: "choose", category: activeTab })
                        }}
                      >
                        <Plus className="size-4" aria-hidden />
                        {activeTab === "im" ? "Connect IM" : "New webhook"}
                      </Button>
                    </div>

                    <ul className="divide-y divide-border/70">
                      {visibleTriggers.map((webhook) => {
                        const isIm = webhook.category === "im"
                        const isWeChat = webhook.provider === "wechat"
                        const canRotateLink =
                          webhook.transport === "cloud_webhook" && webhook.provider !== "telegram"
                        const historyExpanded = expandedDeliveriesId === webhook.id
                        const toggling = webhooksApi.togglingWebhookId === webhook.id
                        const testingThis = webhooksApi.testingWebhookId === webhook.id
                        const needsSetup = webhook.connectionStatus === "setup_required"
                        const needsQr =
                          isWeChat &&
                          (webhook.connectionStatus === "scan_required" ||
                            webhook.connectionStatus === "session_expired" ||
                            webhook.connectionStatus === "error")

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
                                    <TriggerStatusBadge webhook={webhook} />
                                  </div>
                                  <p className="text-xs leading-5 text-muted-foreground">
                                    {triggerSubtitle(webhook)}
                                  </p>
                                  {webhook.connectionStatus === "error" && webhook.daemonLastError ? (
                                    <p className="text-xs leading-5 text-destructive">
                                      {webhook.daemonLastError}
                                    </p>
                                  ) : null}
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
                              {needsQr ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-11 gap-1.5 text-foreground sm:h-7"
                                  data-testid={tid.botImRescan(webhook.id)}
                                  onClick={() => {
                                    setActionError(null)
                                    setView({ kind: "qr", webhookId: webhook.id, fallbackWebhook: webhook })
                                  }}
                                >
                                  <Smartphone className="size-3.5" aria-hidden />
                                  {webhook.connectionStatus === "scan_required" ? "Scan QR" : "Re-scan QR"}
                                </Button>
                              ) : needsSetup ? (
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
                                  {isIm ? "Finish setup" : "Add key"}
                                </Button>
                              ) : null}

                              {!isIm ? (
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
                              ) : null}

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
                                {isWeChat && !needsQr ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="size-11 text-muted-foreground hover:text-foreground sm:size-7"
                                    aria-label={`Re-scan QR for ${webhook.name}`}
                                    onClick={() => {
                                      setActionError(null)
                                      setView({ kind: "qr", webhookId: webhook.id, fallbackWebhook: webhook })
                                    }}
                                  >
                                    <Smartphone className="size-3.5" aria-hidden />
                                  </Button>
                                ) : canRotateLink ? (
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
                                ) : null}
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
                              <TriggerHistoryPanel
                                botId={bot.id}
                                webhook={webhook}
                                allowingSenderKey={webhooksApi.allowingSenderKey}
                                onAllowSender={handleAllowSender}
                              />
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
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
            if (rotated.webhook.provider === "telegram") {
              toast.success("Telegram link reset and re-registered")
            } else {
              setRevealed({
                heading: "Link reset",
                webhook: rotated.webhook,
                webhookUrl: rotated.webhookUrl,
                signingSecret: rotated.signingSecret ?? null,
              })
            }
          } catch (cause) {
            if (!isAbortError(cause)) {
              setConfirmRotate((current) => ({ ...current, open: false }))
              setActionError(getErrorMessage(cause, "Could not reset link. Try again."))
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
        description={
          confirmDelete.webhook?.category === "im"
            ? "This IM connection and its saved reply links will stop working right away."
            : "This trigger link will stop working right away and its history will be removed."
        }
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
            if (expandedDeliveriesId === target.id) setExpandedDeliveriesId(null)
            setConfirmDelete((current) => ({ ...current, open: false }))
            toast.success(`Deleted ${target.name}`)
          } catch (cause) {
            if (!isAbortError(cause)) {
              setConfirmDelete((current) => ({ ...current, open: false }))
              setActionError(getErrorMessage(cause, "Could not delete this trigger. Try again."))
            }
          }
        }}
      />
    </>
  )
}
