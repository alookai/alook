import type { queries } from "@alook/shared"

type Provider = queries.accountDeletion.AccountDeletionSnapshot["providers"][number]

const PROVIDER_TIMEOUT_MS = 10_000

async function providerFetch(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`provider revocation returned ${response.status}`)
}

export async function revokeProviderAccount(
  env: Pick<Env, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">,
  provider: Provider,
): Promise<void> {
  if (provider.providerId === "google") {
    const token = provider.refreshToken ?? provider.accessToken
    if (!token) return
    await providerFetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    })
    return
  }

  if (provider.providerId === "github") {
    if (!provider.accessToken) return
    const credentials = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)
    await providerFetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        "User-Agent": "Alook",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: provider.accessToken }),
    })
  }
}
