import { limitsSchema, PageError, type PageLimits } from "./contracts"

export type Settings = ReturnType<typeof settings>

function integer(value: string, min: number, max: number): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PageError("invalid_operator_config", 503)
  }
  return parsed
}

function names(value: string): string[] {
  const result = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean)
  if (result.some(item => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item))) throw new PageError("invalid_operator_config", 503)
  return result
}

export function settings(env: Omit<Env, "REGISTRY" | "DISPATCHER">) {
  if (!/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(env.CF_NAMESPACE)
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(env.BASE_DOMAIN)) {
    throw new PageError("invalid_operator_config", 503)
  }
  return {
    account: env.CF_ACCOUNT_ID,
    namespace: env.CF_NAMESPACE,
    domain: env.BASE_DOMAIN,
    limits: {
      cpuMs: integer(env.PAGE_CPU_MS, 1, 300_000),
      subRequests: integer(env.PAGE_SUBREQUESTS, 1, 1_000),
    },
    uploadBytes: integer(env.UPLOAD_MAX_BYTES, 1, 16 * 1024 * 1024),
    fileBytes: integer(env.FILE_MAX_BYTES, 1, 8 * 1024 * 1024),
    fileCount: integer(env.UPLOAD_MAX_FILES, 1, 128),
    timeoutMs: integer(env.CF_TIMEOUT_MS, 1, 120_000),
    reservedExact: ["www", "api", "admin", "auth", "mail", "alook", ...names(env.RESERVED_EXACT)],
    reservedPrefixes: ["alook-", "internal-", ...names(env.RESERVED_PREFIXES)],
    sensitiveExact: names(env.SENSITIVE_EXACT),
    sensitivePrefixes: names(env.SENSITIVE_PREFIXES),
  }
}

export function configuredLimits(input: unknown, ceiling: PageLimits): PageLimits {
  const result = limitsSchema.safeParse(input)
  if (!result.success || result.data.cpuMs > ceiling.cpuMs || result.data.subRequests > ceiling.subRequests) {
    throw new PageError("invalid_limits")
  }
  return result.data
}

export function effectiveLimits(limits: PageLimits, ceiling: PageLimits): PageLimits {
  return { cpuMs: Math.min(limits.cpuMs, ceiling.cpuMs), subRequests: Math.min(limits.subRequests, ceiling.subRequests) }
}
