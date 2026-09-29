export type SpikeLogEntry = {
  kind: string
  detail: Record<string, unknown>
  generation: number
  time: string
}

export type SpikeSnapshot = {
  account: string
  capabilityGap: string
  generation: number
  logs: SpikeLogEntry[]
  messages: Array<{ id: string; channelId: string; seq: number; text: string }>
  offline: boolean
  servers: Array<{ id: string; name: string; version: number }>
}

export type SpikeTestApi = {
  applyLocalServer: (row: { id: string; name: string; version: number }) => void
  snapshot: () => SpikeSnapshot
  rebuild: () => Promise<void>
  waitForIdle: () => Promise<void>
}
