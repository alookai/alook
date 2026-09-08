import type { BetterAuthPlugin } from "better-auth"
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose"
import { APPLE_ISSUER } from "@/lib/apple-auth"

export const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`

const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL))

type AppleVerificationKey = CryptoKey | Uint8Array | JWTVerifyGetKey

type VerifyAppleIdTokenOptions = {
  key?: AppleVerificationKey
  currentDate?: Date
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function verifyAppleIdToken(
  token: string,
  expectedNonce: string,
  clientId: string,
  options: VerifyAppleIdTokenOptions = {},
): Promise<boolean> {
  if (!token || !expectedNonce || !clientId) return false

  try {
    if (decodeProtectedHeader(token).alg !== "RS256") return false

    const { payload } = await jwtVerify(token, options.key ?? appleJwks, {
      algorithms: ["RS256"],
      issuer: APPLE_ISSUER,
      audience: clientId,
      maxTokenAge: "1h",
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "nonce"],
      currentDate: options.currentDate,
    })

    if (typeof payload.sub !== "string" || payload.sub.length === 0) return false
    if (typeof payload.nonce !== "string" || payload.nonce.length === 0) return false

    return payload.nonce === expectedNonce || payload.nonce === await sha256Hex(expectedNonce)
  } catch {
    return false
  }
}

type AppleIdTokenVerifier = (
  token: string,
  expectedNonce: string,
  clientId: string,
) => Promise<boolean>

export function appleOauthHardeningPlugin(
  clientId: string,
  verifyIdToken: AppleIdTokenVerifier = verifyAppleIdToken,
): BetterAuthPlugin {
  return {
    id: "apple-oauth-hardening",
    init(ctx) {
      const appleProviders = ctx.socialProviders.filter((provider) => provider.id === "apple")
      if (appleProviders.length !== 1) {
        throw new Error("Apple OAuth hardening could not be initialized")
      }

      const provider = appleProviders[0]
      if (!provider.options) {
        throw new Error("Apple OAuth hardening could not be initialized")
      }

      provider.requiresIdTokenNonce = true
      provider.issuer = APPLE_ISSUER
      provider.options.disableIdTokenSignIn = true

      const createAuthorizationURL = provider.createAuthorizationURL.bind(provider)
      provider.createAuthorizationURL = async (data) => {
        if (!data.idTokenNonce) {
          throw new Error("Apple OAuth authorization could not be initialized")
        }

        const url = await createAuthorizationURL(data)
        url.searchParams.set("nonce", data.idTokenNonce)
        return url
      }

      const getUserInfo = provider.getUserInfo.bind(provider)
      provider.getUserInfo = async (tokens) => {
        if (!tokens.idToken || !tokens.expectedIdTokenNonce) return null
        if (!await verifyIdToken(tokens.idToken, tokens.expectedIdTokenNonce, clientId)) {
          return null
        }
        return getUserInfo(tokens)
      }
    },
  }
}
