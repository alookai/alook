"use client"

import { useEffect, useRef, useState } from "react"
import { isTauri, safeRedirectPath, type NativeOauthProvider } from "@alook/shared"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { signIn } from "@/lib/auth-client"
import { createNativeOauthController, nativeOauthBrowserDeps, type NativeOauthView } from "@/lib/native-oauth-client"
import {
  APPLE_LEFT_ALIGNED_LOGO_BLACK,
  APPLE_LEFT_ALIGNED_LOGO_WHITE,
} from "./apple-sign-in-artwork"

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
}: {
  postLoginUrl: string
  appleEnabled?: boolean
}) {
  const controller = useRef<ReturnType<typeof createNativeOauthController> | null>(null)
  const [native, setNative] = useState<NativeOauthView | null>(null)
  const lastProvider = useRef<NativeOauthProvider>("github")
  useEffect(() => {
    if (!isTauri()) return
    const instance = createNativeOauthController(nativeOauthBrowserDeps, setNative)
    controller.current = instance
    void instance.connect()
    return () => { instance.dispose(); if (controller.current === instance) controller.current = null }
  }, [])
  const begin = (provider: NativeOauthProvider) => {
    lastProvider.current = provider
    if (!isTauri()) { void signIn.social({ provider, callbackURL: postLoginUrl }); return }
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
      <Field className="grid grid-cols-2 gap-4">
        <Button
          size="lg"
          type="button"
          disabled={busy || unsupported}
          className="border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
          data-testid="native-oauth-github"
          onClick={() => begin("github")}
        >
          <span className="inline-flex items-center gap-2" data-testid="native-oauth-github-content">
            <SiGithub className="size-4" aria-hidden />
            <span>GitHub</span>
          </span>
        </Button>
        <Button
          size="lg"
          type="button"
          disabled={busy || unsupported}
          className="border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
          data-testid="native-oauth-google"
          onClick={() => begin("google")}
        >
          <span className="inline-flex items-center gap-2" data-testid="native-oauth-google-content">
            <SiGoogle className="size-4" aria-hidden />
            <span>Google</span>
          </span>
        </Button>
        {appleEnabled ? (
          <Button
            type="button"
            size="lg"
            disabled={busy || unsupported || appleUpdateRequired}
            className="col-span-2 min-w-35 border-0 bg-apple-signin text-base text-apple-signin-foreground hover:bg-apple-signin"
            data-testid="native-oauth-apple"
            onClick={() => begin("apple")}
          >
            <span className="inline-flex items-center gap-2" data-testid="native-oauth-apple-content">
              <span className="grid h-9 place-items-center" aria-hidden>
                <Image
                  src={APPLE_LEFT_ALIGNED_LOGO_WHITE}
                  alt=""
                  width={31}
                  height={44}
                  unoptimized
                  className="col-start-1 row-start-1 h-9 w-auto dark:hidden"
                  data-testid="apple-official-left-aligned-logo-white"
                />
                <Image
                  src={APPLE_LEFT_ALIGNED_LOGO_BLACK}
                  alt=""
                  width={31}
                  height={44}
                  unoptimized
                  className="col-start-1 row-start-1 hidden h-9 w-auto dark:block"
                  data-testid="apple-official-left-aligned-logo-black"
                />
              </span>
              <span>Continue with Apple</span>
            </span>
          </Button>
        ) : null}
      </Field>
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
