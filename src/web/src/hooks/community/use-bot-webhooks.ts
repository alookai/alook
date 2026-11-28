"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  BotImAllowSenderResponseSchema,
  BotImQrStartResponseSchema,
  BotImQrStatusResponseSchema,
  BotWebhookCreateResponseSchema,
  BotWebhookDeliveriesResponseSchema,
  BotWebhookListResponseSchema,
  BotWebhookTestResponseSchema,
  BotWebhookUpdateResponseSchema,
  type BotImAllowSenderResponse,
  type BotImQrStartResponse,
  type BotImQrStatusResponse,
  type BotWebhookCreateInput,
  type BotWebhookCreateResponse,
  type BotWebhookDelivery,
  type BotWebhookSummary,
  type BotWebhookTestResponse,
  type BotWebhookUpdateInput,
  type BotWebhookUpdateResponse,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

function webhooksBasePath(botId: string) {
  return `/api/community/bots/${encodeURIComponent(botId)}/webhooks`
}

function toLastDelivery(delivery: BotWebhookDelivery): BotWebhookSummary["lastDelivery"] {
  return {
    id: delivery.id,
    direction: delivery.direction,
    senderId: delivery.senderId,
    senderLabel: delivery.senderLabel,
    chatLabel: delivery.chatLabel,
    status: delivery.status,
    eventType: delivery.eventType,
    summary: delivery.summary,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
  }
}

export function useBotWebhooks(botId: string, open: boolean) {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`bot-webhooks:${botId}`, open)
  const queryKey = communityKeys.botWebhooks(botId)

  const query = useQuery<{ webhooks: BotWebhookSummary[] }>({
    queryKey,
    enabled: open && Boolean(botId),
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(webhooksBasePath(botId), {
        signal: AbortSignal.any([signal, view.signal]),
        assertActive: view,
      })
      view()
      return BotWebhookListResponseSchema.parse(raw)
    },
  })

  const createMutation = useMutation<BotWebhookCreateResponse, Error, BotWebhookCreateInput>({
    mutationKey: [...queryKey, "create"],
    retry: false,
    mutationFn: async (input) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(webhooksBasePath(botId), {
        method: "POST",
        body: JSON.stringify(input),
        signal: view.signal,
        assertActive: view,
      })
      view()
      return BotWebhookCreateResponseSchema.parse(raw)
    },
    onSuccess: (created) => {
      client.setQueryData<{ webhooks: BotWebhookSummary[] }>(queryKey, (current) => ({
        webhooks: [
          created.webhook,
          ...(current?.webhooks.filter((item) => item.id !== created.webhook.id) ?? []),
        ],
      }))
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
    },
  })

  const updateMutation = useMutation<
    BotWebhookUpdateResponse,
    Error,
    { webhookId: string; input: BotWebhookUpdateInput }
  >({
    mutationKey: [...queryKey, "update"],
    retry: false,
    mutationFn: async ({ webhookId, input }) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(webhookId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
          signal: view.signal,
          assertActive: view,
        },
      )
      view()
      return BotWebhookUpdateResponseSchema.parse(raw)
    },
    onSuccess: (updated) => {
      client.setQueryData<{ webhooks: BotWebhookSummary[] }>(queryKey, (current) => {
        if (!current) return { webhooks: [updated.webhook] }
        return {
          webhooks: current.webhooks.map((item) =>
            item.id === updated.webhook.id ? updated.webhook : item,
          ),
        }
      })
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
    },
  })

  const deleteMutation = useMutation<void, Error, string>({
    mutationKey: [...queryKey, "delete"],
    retry: false,
    mutationFn: async (webhookId) => {
      const view = source.capture()
      view()
      await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(webhookId)}`,
        {
          method: "DELETE",
          signal: view.signal,
          assertActive: view,
        },
      )
      view()
    },
    onSuccess: (_, webhookId) => {
      client.setQueryData<{ webhooks: BotWebhookSummary[] }>(queryKey, (current) =>
        current
          ? { webhooks: current.webhooks.filter((item) => item.id !== webhookId) }
          : current,
      )
      client.removeQueries({
        queryKey: communityKeys.botWebhookDeliveries(botId, webhookId),
        exact: true,
      })
      client.removeQueries({
        queryKey: communityKeys.botImQrStatus(botId, webhookId),
        exact: true,
      })
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
    },
  })

  const testMutation = useMutation<BotWebhookTestResponse, Error, string>({
    mutationKey: [...queryKey, "test"],
    retry: false,
    mutationFn: async (webhookId) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(webhookId)}/test`,
        {
          method: "POST",
          signal: view.signal,
          assertActive: view,
        },
      )
      view()
      return BotWebhookTestResponseSchema.parse(raw)
    },
    onSuccess: ({ delivery }, webhookId) => {
      client.setQueryData<{ webhooks: BotWebhookSummary[] }>(queryKey, (current) =>
        current
          ? {
              webhooks: current.webhooks.map((item) =>
                item.id === webhookId
                  ? {
                      ...item,
                      lastTriggeredAt: delivery.createdAt,
                      lastDelivery: toLastDelivery(delivery),
                    }
                  : item,
              ),
            }
          : current,
      )
      const deliveriesKey = communityKeys.botWebhookDeliveries(botId, webhookId)
      client.setQueryData<{ deliveries: BotWebhookDelivery[] }>(deliveriesKey, (current) =>
        current
          ? {
              deliveries: [
                delivery,
                ...current.deliveries.filter((item) => item.id !== delivery.id),
              ],
            }
          : undefined,
      )
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
      void client.invalidateQueries({ queryKey: deliveriesKey, exact: true }).catch(() => undefined)
    },
  })

  const allowSenderMutation = useMutation<
    BotImAllowSenderResponse,
    Error,
    { webhookId: string; senderId: string }
  >({
    mutationKey: [...queryKey, "allow-sender"],
    retry: false,
    mutationFn: async ({ webhookId, senderId }) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(webhookId)}/allow-sender`,
        {
          method: "POST",
          body: JSON.stringify({ senderId }),
          signal: view.signal,
          assertActive: view,
        },
      )
      view()
      return BotImAllowSenderResponseSchema.parse(raw)
    },
    onSuccess: ({ webhook }) => {
      client.setQueryData<{ webhooks: BotWebhookSummary[] }>(queryKey, (current) => {
        if (!current) return { webhooks: [webhook] }
        return {
          webhooks: current.webhooks.map((item) => (item.id === webhook.id ? webhook : item)),
        }
      })
      void client.invalidateQueries({ queryKey, exact: true }).catch(() => undefined)
    },
  })

  const startImQrMutation = useMutation<BotImQrStartResponse, Error, string>({
    mutationKey: [...queryKey, "im-qr-start"],
    retry: false,
    mutationFn: async (triggerId) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(triggerId)}/im-qr`,
        {
          method: "POST",
          signal: view.signal,
          assertActive: view,
        },
      )
      view()
      return BotImQrStartResponseSchema.parse(raw)
    },
    onSuccess: (started, triggerId) => {
      const qrKey = communityKeys.botImQrStatus(botId, triggerId)
      client.setQueryData<BotImQrStatusResponse>(qrKey, (current) => ({
        triggerId,
        connectionStatus: current?.connectionStatus ?? "scan_required",
        qrStatus: started.status,
        sessionId: started.sessionId,
        qrUrl: started.qrUrl,
        expiresAt: started.expiresAt,
        botAccountLabel: current?.botAccountLabel ?? null,
        error: null,
      }))
    },
  })

  return {
    ...query,
    webhooks: query.data?.webhooks ?? [],
    createWebhook: createMutation.mutateAsync,
    updateWebhook: (webhookId: string, input: BotWebhookUpdateInput) =>
      updateMutation.mutateAsync({ webhookId, input }),
    deleteWebhook: deleteMutation.mutateAsync,
    testWebhook: testMutation.mutateAsync,
    allowSender: (webhookId: string, senderId: string) =>
      allowSenderMutation.mutateAsync({ webhookId, senderId }),
    startImQr: startImQrMutation.mutateAsync,
    creating: createMutation.isPending,
    updating: updateMutation.isPending,
    deleting: deleteMutation.isPending,
    testing: testMutation.isPending,
    testingWebhookId: testMutation.isPending ? (testMutation.variables ?? null) : null,
    togglingWebhookId:
      updateMutation.isPending && updateMutation.variables?.input.enabled !== undefined
        ? updateMutation.variables.webhookId
        : null,
    allowingSenderKey: allowSenderMutation.isPending && allowSenderMutation.variables
      ? `${allowSenderMutation.variables.webhookId}:${allowSenderMutation.variables.senderId}`
      : null,
    startingQrTriggerId: startImQrMutation.isPending ? (startImQrMutation.variables ?? null) : null,
    pending:
      createMutation.isPending ||
      updateMutation.isPending ||
      deleteMutation.isPending ||
      testMutation.isPending ||
      allowSenderMutation.isPending ||
      startImQrMutation.isPending,
    capture: source.capture,
  }
}

export function useBotWebhookDeliveries(
  botId: string,
  webhookId: string | null,
  open: boolean,
) {
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(
    `bot-webhook-deliveries:${botId}:${webhookId ?? "none"}`,
    open && Boolean(webhookId),
  )
  const queryKey = communityKeys.botWebhookDeliveries(botId, webhookId ?? "__none__")

  const query = useQuery<{ deliveries: BotWebhookDelivery[] }>({
    queryKey,
    enabled: open && Boolean(botId) && Boolean(webhookId),
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(webhookId!)}/deliveries`,
        {
          signal: AbortSignal.any([signal, view.signal]),
          assertActive: view,
        },
      )
      view()
      return BotWebhookDeliveriesResponseSchema.parse(raw)
    },
  })

  return {
    ...query,
    deliveries: query.data?.deliveries ?? [],
  }
}

export function useBotImQrStatus(
  botId: string,
  triggerId: string | null,
  open: boolean,
) {
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(
    `bot-im-qr:${botId}:${triggerId ?? "none"}`,
    open && Boolean(triggerId),
  )
  const queryKey = communityKeys.botImQrStatus(botId, triggerId ?? "__none__")

  const query = useQuery<BotImQrStatusResponse>({
    queryKey,
    enabled: open && Boolean(botId) && Boolean(triggerId),
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.qrStatus
      return status === "pending" || status === "scanned" ? 2_500 : false
    },
    queryFn: async ({ signal }) => {
      const view = source.capture()
      view()
      const raw = await origin.fetch<unknown>(
        `${webhooksBasePath(botId)}/${encodeURIComponent(triggerId!)}/im-qr`,
        {
          signal: AbortSignal.any([signal, view.signal]),
          assertActive: view,
        },
      )
      view()
      return BotImQrStatusResponseSchema.parse(raw)
    },
  })

  return {
    ...query,
    qrState: query.data ?? null,
  }
}
