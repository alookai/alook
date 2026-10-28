"use client"

import { captureProductAnalytics } from "@/lib/product-analytics"

import { startAction, finishAction, type Action } from "@/lib/observability/context"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useEffect, useRef } from "react"
import { safeRedirectPath } from "@/lib/safe-redirect"
import { isTauri, type NativeOauthProvider } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { signIn } from "@/lib/auth-client"
import { createNativeOauthController, nativeOauthBrowserDeps, type NativeOauthView } from "@/lib/native-oauth-client"
import { SocialSignInButtons } from "./social-sign-in-buttons"

const messages = {
  start_failed: "Couldn't open sign-in. Try again.",
  expired: "This sign-in attempt expired. Try again.",
  denied: "Sign-in was cancelled in your browser. You can try again.",
  invalid_callback: "That sign-in link wasn't valid. Waiting for your browser to finish.",
  retry_required: "Couldn't confirm sign-in. Try again to start a new attempt.",
  unavailable: "Sign-in is unavailable. Try again or use email.",
  apple_update_required: "Update Alook to continue with Apple. GitHub, Google, and email still work.",
} as const

export function SocialSignIn({
  postLoginUrl,
  appleEnabled = false,
  requestConsent,
}: {
  postLoginUrl: string
  appleEnabled?: boolean
  requestConsent: (continuation: () => void) => void
}) {
  const observed = useRef<Action | undefined>(undefined)
  const controller = useRef<ReturnType<typeof createNativeOauthController> | null>(null)
  const [native, setNative] = useAtom(useCreateAtom<NativeOauthView | null>(null))
  const lastProvider = useRef<NativeOauthProvider>("github")
  useEffect(() => {
    if (!isTauri()) return
    const instance = createNativeOauthController(nativeOauthBrowserDeps, view => {
      setNative(view)
      if (["waiting", "error", "unsupported", "idle"].includes(view.phase)) finishAction(observed.current, view.phase === "error" ? "error" : view.phase === "idle" ? "cancelled" : "observed")
    })
    controller.current = instance
    void instance.connect()
    return () => { instance.dispose(); if (controller.current === instance) controller.current = null }
  }, [setNative])
  const begin = (provider: NativeOauthProvider) => requestConsent(() => start(provider))
  const start = (provider: NativeOauthProvider) => {
    finishAction(observed.current, "superseded")
    observed.current = startAction("auth_social", { capability: "limited", phase: "auth" })
    lastProvider.current = provider
    const action = observed.current
    if (!isTauri()) {
      const failed = (error: unknown) => { void captureProductAnalytics({ event: "sign_in_failed", method: provider, failureStage: "social_start", error }) }
      void signIn.social({ provider, callbackURL: postLoginUrl }).then(result => {
        finishAction(action, result.error ? "error" : "observed")
        if (result.error) failed(result.error)
      }, error => { finishAction(action, "error"); failed(error) })
      return
    }
    if (controller.current) void controller.current.start(provider, safeRedirectPath(postLoginUrl))
  }
  const busy = native?.phase === "initializing" || native?.phase === "preparing" || native?.phase === "exchanging" || native?.phase === "checking_status"
  const unsupported = native?.phase === "unsupported"
  const appleUpdateRequired = native?.message === "apple_update_required"
  const text = unsupported ? "Update Alook to use social sign-in. You can still use email."
    : native?.message ? messages[native.message]
    : native?.phase === "preparing" ? "Opening sign-in in your browser…"
    : native?.phase === "exchanging" || native?.phase === "checking_status" ? "Confirming sign-in…"
    : native?.phase === "waiting" ? "Finish signing in in your browser."
    : undefined
  return (
    <>
      <SocialSignInButtons appleEnabled={appleEnabled} disabled={busy || unsupported} appleDisabled={appleUpdateRequired} onProvider={begin} />
      {text && <p role={native?.phase === "error" || unsupported ? "alert" : "status"} className="text-center text-sm text-muted-foreground" data-testid="native-oauth-status">{text}</p>}
      {!unsupported && !appleUpdateRequired && native && (native.attempt || native.phase === "error" || native.phase === "preparing") && (
        <div className="flex justify-center gap-2">
          {(native.attempt || native.phase === "preparing") && <Button type="button" variant="link" className="h-11 px-3 sm:h-8" data-testid="native-oauth-cancel" onClick={() => { void controller.current?.cancel() }}>Cancel</Button>}
          <Button type="button" variant="link" className="h-11 px-3 sm:h-8" disabled={busy} data-testid="native-oauth-retry" onClick={() => begin(native.attempt?.provider ?? lastProvider.current)}>Try again</Button>
        </div>
      )}
    </>
  )
}
