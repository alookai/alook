import type { SpikeTestApi } from "./test-api"

declare global {
  interface Window {
    __tanstackOfficialSpike: SpikeTestApi
  }
}

export {}
