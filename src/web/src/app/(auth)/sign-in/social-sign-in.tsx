"use client"

import { useEffect, useRef, useState } from "react"
import { isTauri, safeRedirectPath } from "@alook/shared"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { signIn } from "@/lib/auth-client"
import { createNativeOauthController, nativeOauthBrowserDeps, type NativeOauthView } from "@/lib/native-oauth-client"

const messages = {
  start_failed: "Couldn't open sign-in. Try again.",
  expired: "This sign-in attempt expired. Try again.",
  denied: "Sign-in was cancelled in your browser. You can try again.",
  invalid_callback: "That sign-in link wasn't valid. Waiting for your browser to finish.",
  retry_required: "Couldn't confirm sign-in. Try again to start a new attempt.",
  unavailable: "Sign-in is unavailable. Try again or use email.",
} as const

export function SocialSignIn({ postLoginUrl }: { postLoginUrl: string }) {
  const controller = useRef<ReturnType<typeof createNativeOauthController> | null>(null)
  const [native, setNative] = useState<NativeOauthView | null>(null)
  const lastProvider = useRef<"github" | "google">("github")
  useEffect(() => {
    if (!isTauri()) return
    const instance = createNativeOauthController(nativeOauthBrowserDeps, setNative)
    controller.current = instance
    void instance.connect()
    return () => { instance.dispose(); if (controller.current === instance) controller.current = null }
  }, [])
  const begin = (provider: "github" | "google") => {
    lastProvider.current = provider
    if (!isTauri()) { void signIn.social({ provider, callbackURL: postLoginUrl }); return }
    if (controller.current) void controller.current.start(provider, safeRedirectPath(postLoginUrl))
  }
  const busy = native?.phase === "initializing" || native?.phase === "preparing" || native?.phase === "exchanging" || native?.phase === "checking_status"
  const unsupported = native?.phase === "unsupported"
  const text = unsupported ? "Update Alook to sign in with GitHub or Google. You can still use email."
    : native?.message ? messages[native.message]
    : native?.phase === "preparing" ? "Opening sign-in in your browser…"
    : native?.phase === "exchanging" || native?.phase === "checking_status" ? "Confirming sign-in…"
    : native?.phase === "waiting" ? "Finish signing in in your browser."
    : undefined
  return (
    <>
      <Field className="grid grid-cols-2 gap-4">
        <Button variant="outline" type="button" disabled={busy || unsupported} data-testid="native-oauth-github" onClick={() => begin("github")}>
          <SiGithub className="size-4" />GitHub
        </Button>
        <Button variant="outline" type="button" disabled={busy || unsupported} data-testid="native-oauth-google" onClick={() => begin("google")}>
          <SiGoogle className="size-4" />Google
        </Button>
      </Field>
      {text && <p role={native?.phase === "error" || unsupported ? "alert" : "status"} className="text-sm text-muted-foreground" data-testid="native-oauth-status">{text}</p>}
      {!unsupported && native && (native.attempt || native.phase === "error" || native.phase === "preparing") && (
        <div className="flex gap-2">
          {(native.attempt || native.phase === "preparing") && <Button type="button" variant="ghost" data-testid="native-oauth-cancel" onClick={() => { void controller.current?.cancel() }}>Cancel</Button>}
          <Button type="button" variant="outline" disabled={busy} data-testid="native-oauth-retry" onClick={() => begin(native.attempt?.provider ?? lastProvider.current)}>Try again</Button>
        </div>
      )}
    </>
  )
}
