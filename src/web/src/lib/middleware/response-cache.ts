export function varyPrivateResponseByCredentials(response: Response): Response {
  const directives = response.headers.get("Cache-Control")?.split(",") ?? []
  if (!directives.some((directive) => directive.split("=", 1)[0].trim().toLowerCase() === "private")) return response
  const vary = response.headers.get("Vary")?.split(",").map((field) => field.trim()).filter(Boolean) ?? []
  const fields = new Set(vary.map((field) => field.toLowerCase()))
  if (fields.has("*")) return response
  const missing = ["Cookie", "Authorization"].filter((field) => !fields.has(field.toLowerCase()))
  if (missing.length === 0) return response
  const result = new Response(response.body, response)
  result.headers.set("Vary", [...vary, ...missing].join(", "))
  return result
}
