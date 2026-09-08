import { importPKCS8, SignJWT } from "jose"

export const APPLE_ISSUER = "https://appleid.apple.com"
export const APPLE_CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60

const APPLE_CONFIG_KEYS = [
  "APPLE_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
] as const

type AppleConfigKey = (typeof APPLE_CONFIG_KEYS)[number]

export type AppleAuthEnv = Partial<Record<AppleConfigKey, string | undefined>>

export type AppleAuthConfig = {
  clientId: string
  teamId: string
  keyId: string
  privateKey: string
}

export type AppleAuthConfigState =
  | { enabled: false }
  | { enabled: true; config: AppleAuthConfig }

export class AppleAuthConfigurationError extends Error {
  constructor() {
    super("Apple authentication configuration is incomplete")
    this.name = "AppleAuthConfigurationError"
  }
}

export function resolveAppleAuthConfig(env: AppleAuthEnv): AppleAuthConfigState {
  const values = APPLE_CONFIG_KEYS.map((key) => {
    const value = env[key]
    return typeof value === "string" ? value.trim() : ""
  })
  const present = values.filter(Boolean).length
  if (present === 0) return { enabled: false }
  if (present !== APPLE_CONFIG_KEYS.length) throw new AppleAuthConfigurationError()

  const [clientId, teamId, keyId, privateKey] = values as [string, string, string, string]
  return {
    enabled: true,
    config: { clientId, teamId, keyId, privateKey },
  }
}

export async function generateAppleClientSecret(
  config: AppleAuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await importPKCS8(config.privateKey, "ES256")
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + APPLE_CLIENT_SECRET_TTL_SECONDS)
    .sign(key)
}

export type StoredAppleUser = {
  email: string
  emailVerified: boolean | null
  name: string
}

export type AppleProfileForMapping = {
  sub: string
  email?: string
  email_verified?: boolean | string
}

export async function mapAppleProfileToUser(
  profile: AppleProfileForMapping,
  findExisting: (sub: string) => Promise<StoredAppleUser | null>,
): Promise<{ email?: string; emailVerified?: boolean; name?: string }> {
  const sub = profile.sub.trim()
  if (!sub) return {}

  const email = profile.email?.trim()
  const emailVerified = profile.email_verified === true || profile.email_verified === "true"
  if (email && emailVerified) return { email, emailVerified: true }

  const existing = await findExisting(sub)
  if (!existing || existing.emailVerified !== true) return {}
  return {
    email: existing.email,
    emailVerified: true,
    name: existing.name,
  }
}
