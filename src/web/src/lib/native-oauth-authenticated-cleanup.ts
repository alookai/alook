import {
  isDesktop,
  isTauri,
  nativeOauthProofSchema,
  tauriInvoke,
} from "@alook/shared"
import { nativeOauthSnapshotSchema } from "@/lib/native-oauth-schema"

const browserDeps = {
  isDesktopTauri: () => isTauri() && isDesktop(),
  invoke: tauriInvoke,
  postCancel: (proof: unknown) => fetch("/api/auth/native/cancel", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
    signal: AbortSignal.timeout(15_000),
  }),
}

export async function cleanupAuthenticatedNativeOauthResidue(
  deps: {
    isDesktopTauri: () => boolean
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
    postCancel: (proof: unknown) => Promise<unknown>
  } = browserDeps,
): Promise<void> {
  if (!deps.isDesktopTauri()) return
  const snapshot = nativeOauthSnapshotSchema.nullable().parse(
    await deps.invoke("native_oauth_snapshot"),
  )
  if (!snapshot) return
  const proof = nativeOauthProofSchema.nullable().parse(
    await deps.invoke("native_oauth_cancel", { attemptId: snapshot.attemptId }),
  )
  if (!proof) return
  await deps.postCancel(proof).catch(() => {})
}
