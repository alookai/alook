import type { Settings } from "./config"
import { PageError } from "./contracts"

export function normalizePrefix(input: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(input)) throw new PageError("invalid_prefix")
  return input.toLowerCase()
}

export function availablePrefix(input: string, config: Settings): string {
  const prefix = normalizePrefix(input)
  if (config.reservedExact.includes(prefix) || config.reservedPrefixes.some(value => prefix.startsWith(value))) {
    throw new PageError("reserved_prefix")
  }
  if (config.sensitiveExact.includes(prefix) || config.sensitivePrefixes.some(value => prefix.startsWith(value))) throw new PageError("sensitive_prefix")
  return prefix
}

export function hostPrefix(url: URL, domain: string): string {
  if (url.port || url.username || url.password || !url.hostname.endsWith(`.${domain}`)) throw new PageError("unknown_host", 404)
  try {
    return normalizePrefix(url.hostname.slice(0, -(domain.length + 1)))
  } catch {
    throw new PageError("unknown_host", 404)
  }
}
