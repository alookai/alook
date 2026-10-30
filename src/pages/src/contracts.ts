import { z } from "zod"

export class PageError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code)
  }
}

export const limitsSchema = z.strictObject({
  cpuMs: z.number().int().min(1).max(300_000),
  subRequests: z.number().int().min(1).max(1_000),
})
export type PageLimits = z.infer<typeof limitsSchema>

export const moduleTypes = [
  "application/javascript+module", "application/javascript", "text/x-python",
  "text/x-python-requirement", "application/wasm", "text/plain",
  "application/octet-stream", "application/source-map",
] as const

const fileSchema = z.strictObject({
  part: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).refine(value => value !== "manifest"),
  path: z.string().min(1).max(512),
  role: z.enum(["asset", "module"]),
  type: z.string().min(1).max(128),
})

export const manifestSchema = z.strictObject({
  prefix: z.string().optional(),
  entry: z.strictObject({ path: z.string(), format: z.enum(["module", "classic", "python"]) }).optional(),
  compatibilityDate: z.iso.date(),
  compatibilityFlags: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(32).default([]),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(8192)).default({}),
  assets: z.strictObject({
    html_handling: z.enum(["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"]).optional(),
    not_found_handling: z.enum(["none", "404-page", "single-page-application"]).optional(),
    run_worker_first: z.boolean().optional(),
  }).optional(),
  files: z.array(fileSchema).min(1).max(128),
})
export type Manifest = z.infer<typeof manifestSchema>
export type UploadFile = {
  path: string
  type: string
  blob: Blob
  hash: string
} & ({ role: "asset"; assetHash: string } | { role: "module" })
export interface Artifact {
  manifest: Manifest
  files: UploadFile[]
  digest: string
}
export interface Release {
  target: string
  operationId: string
  digest: string
}
export interface Operation extends Release {
  kind: "publish" | "delete" | "cleanup"
  startedAt: string
  putAcknowledged?: boolean
}
export type Phase = "publishing" | "ready" | "failed" | "deleting"
export type Stage = "reserved" | "preflight" | "assets" | "publishing" | "uncertain" | "confirming" | "cleanup" | "deleting" | "blocked"

export function errorResponse(error: unknown): Response {
  const safe = error instanceof PageError ? error : new PageError("internal_error", 500)
  return Response.json({ error: safe.code }, { status: safe.status, headers: { "cache-control": "no-store" } })
}
