import { messageSendCase } from './message-send.mjs'

import { httpCounterControl } from './http-counter-control.mjs'

const cases = { 'channel-message-send': messageSendCase, 'http-counter-control': httpCounterControl }
export function resolveCase(config) {
  const create = cases[config.case ?? 'channel-message-send']
  if (!create) throw new Error(`Unknown case: ${config.case}; available: ${Object.keys(cases).join(', ')}`)
  return create(config)
}
