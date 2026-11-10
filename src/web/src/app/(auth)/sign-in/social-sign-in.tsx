"use client"

import { captureProductAnalytics } from "@/lib/product-analytics"
import { startAction, finishAction, type Action } from "@/lib/observability/context"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useEffect, useRef } from "react"
import { safeRedirectPath } from "@/lib/safe-redirect"
import { isTauri, type NativeOauthProvider } from "@alook/shared"
import { SiApple, SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { signIn } from "@/lib/auth-client"
import { type LoginMethod } from "@/lib/last-login-method"
import {
  createNativeOauthController,
  nativeOauthBrowserDeps,
  type NativeOauthView,
} from "@/lib/native-oauth-client"

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
  lastUsedMethod = null,
}: {
  postLoginUrl: string
  appleEnabled?: boolean
  lastUsedMethod?: LoginMethod | null
}) {
  const observed = useRef<Action | undefined>(undefined)
  const controller = useRef<ReturnType<typeof createNativeOauthController> | null>(null)
  const [native, setNative] = useAtom(useCreateAtom<NativeOauthView | null>(null))
  const browserState = useCreateAtom<{ provider: NativeOauthProvider | null; failed: boolean }>({ provider: null, failed: false })
  const [browser, setBrowser] = useAtom(browserState)
  const [lastProvider, setLastProvider] = useAtom(useCreateAtom<NativeOauthProvider>("github"))

  useEffect(() => {
    if (isTauri()) return
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      finishAction(observed.current, "cancelled")
      observed.current = undefined
      setBrowser({ provider: null, failed: false })
    }
    window.addEventListener("pageshow", restore)
    return () => {
      window.removeEventListener("pageshow", restore)
      observed.current = undefined
      setBrowser({ provider: null, failed: false })
    }
  }, [setBrowser])

  useEffect(() => {
    if (!isTauri()) return
    const instance = createNativeOauthController(nativeOauthBrowserDeps, (view) => {
      setNative(view)
      if (["waiting", "error", "unsupported", "idle"].includes(view.phase)) {
        finishAction(
          observed.current,
          view.phase === "error" ? "error" : view.phase === "idle" ? "cancelled" : "observed",
        )
      }
    })
    controller.current = instance
    void instance.connect()
    return () => {
      instance.dispose()
      if (controller.current === instance) controller.current = null
    }
  }, [setNative])

  const start = (provider: NativeOauthProvider) => {
    if (!isTauri() && browserState.get().provider) return
    finishAction(observed.current, "superseded")
    observed.current = startAction("auth_social", { capability: "limited", phase: "auth" })
    setLastProvider(provider)
    const action = observed.current
    if (!isTauri()) {
      const pending = { provider, failed: false }
      setBrowser(pending)
      const failed = (error: unknown) => {
        if (browserState.get() === pending) setBrowser({ provider: null, failed: true })
        void captureProductAnalytics({
          event: "sign_in_failed",
          method: provider,
          failureStage: "social_start",
          error,
        })
      }
      void signIn.social({ provider, callbackURL: postLoginUrl }).then(
        (result) => {
          finishAction(action, result.error ? "error" : "observed")
          if (result.error) failed(result.error)
        },
        (error) => {
          finishAction(action, "error")
          failed(error)
        },
      )
      return
    }
    if (controller.current) void controller.current.start(provider, safeRedirectPath(postLoginUrl))
  }

  const busy =
    browser.provider !== null
    || native?.phase === "initializing"
    || native?.phase === "preparing"
    || native?.phase === "exchanging"
    || native?.phase === "checking_status"
  const pendingProvider = browser.provider ?? (
    native && ["preparing", "waiting", "exchanging", "checking_status"].includes(native.phase)
      ? native.phase === "preparing" ? lastProvider : native.attempt?.provider ?? lastProvider
      : null
  )
  const unsupported = native?.phase === "unsupported"
  const appleUpdateRequired = native?.message === "apple_update_required"
  const text = browser.failed
    ? messages.start_failed
    : unsupported
    ? "Update Alook to use social sign-in. You can still use email."
    : native?.message
    ? messages[native.message]
    : native?.phase === "preparing"
    ? "Opening sign-in in your browser…"
    : native?.phase === "exchanging" || native?.phase === "checking_status"
    ? "Confirming sign-in…"
    : native?.phase === "waiting"
    ? "Finish signing in in your browser."
    : undefined

  const providers: {
    id: NativeOauthProvider
    label: string
    disabled: boolean
    icon: React.ReactNode
  }[] = [
    {
      id: "github",
      label: "Continue with GitHub",
      disabled: busy || unsupported,
      icon: <SiGithub className="size-4" aria-hidden />,
    },
    {
      id: "google",
      label: "Continue with Google",
      disabled: busy || unsupported,
      icon: <SiGoogle className="size-4" aria-hidden />,
    },
    ...(appleEnabled
      ? [
          {
            id: "apple" as const,
            label: "Continue with Apple",
            disabled: busy || unsupported || appleUpdateRequired,
            icon: <SiApple className="size-4" aria-hidden />,
          },
        ]
      : []),
  ]

  return (
    <>
      <Field className="flex flex-col gap-3">
        {providers.map((provider) => {
          const pending = pendingProvider === provider.id
          const isLastUsed = lastUsedMethod === provider.id
          const badgeId = `last-used-${provider.id}-badge`
          return (
            <div key={provider.id} className="relative">
              <Button
                size="lg"
                type="button"
                disabled={provider.disabled}
                aria-busy={pending}
                aria-describedby={isLastUsed ? badgeId : undefined}
                className="peer h-11 w-full justify-start border-0 bg-apple-signin px-4 text-sm font-medium text-apple-signin-foreground hover:bg-apple-signin hover:opacity-90"
                data-testid={`native-oauth-${provider.id}`}
                onClick={() => start(provider.id)}
              >
                <span
                  className="flex min-w-0 flex-1 items-center gap-2"
                  data-testid={`native-oauth-${provider.id}-content`}
                >
                  <span className="grid h-9 w-6 shrink-0 place-items-center" aria-hidden>
                    {provider.icon}
                  </span>
                  <span className="truncate">{provider.label}</span>
                </span>
                {pending && <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
              </Button>
              {isLastUsed ? (
                <span
                  id={badgeId}
                  data-testid={`last-used-${provider.id}`}
                  className="pointer-events-none absolute -top-2 right-3 rounded-md border border-border bg-background px-1.5 text-[10px] leading-4 font-medium text-muted-foreground peer-disabled:opacity-50"
                >
                  Last used
                </span>
              ) : null}
            </div>
          )
        })}
      </Field>
      {text && (
        <p
          role={browser.failed || native?.phase === "error" || unsupported ? "alert" : "status"}
          className="text-center text-sm text-muted-foreground"
          data-testid="native-oauth-status"
        >
          {text}
        </p>
      )}
      {!unsupported
        && !appleUpdateRequired
        && native
        && (native.attempt || native.phase === "error" || native.phase === "preparing") && (
          <div className="flex justify-center gap-2">
            {(native.attempt || native.phase === "preparing") && (
              <Button
                type="button"
                variant="link"
                className="h-11 px-3 sm:h-8"
                data-testid="native-oauth-cancel"
                onClick={() => {
                  void controller.current?.cancel()
                }}
              >
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="link"
              className="h-11 px-3 sm:h-8"
              disabled={busy}
              data-testid="native-oauth-retry"
              onClick={() => start(native.attempt?.provider ?? lastProvider)}
            >
              Try again
            </Button>
          </div>
        )}
    </>
  )
}
