function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function isCookieHumanSameOrigin(req: Request): boolean {
  const originHeader = req.headers.get("Origin");
  if (!originHeader) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  if (originHeader !== originUrl.origin) return false;

  const requestUrl = new URL(req.url);
  if (originUrl.origin === requestUrl.origin) return true;

  return (
    isLoopbackHostname(originUrl.hostname) &&
    isLoopbackHostname(requestUrl.hostname) &&
    req.headers.get("Host") === originUrl.host
  );
}
