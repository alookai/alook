export function handleHealth(request: Request, url: URL): Response | null {
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ status: "ok" })
  }
  return null
}
