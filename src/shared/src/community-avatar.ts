const EXTERNAL_AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "lh3.googleusercontent.com"])

export function communityExternalAvatarSource(value: string): URL | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !EXTERNAL_AVATAR_HOSTS.has(url.hostname.toLowerCase())) return null
  return url
}
