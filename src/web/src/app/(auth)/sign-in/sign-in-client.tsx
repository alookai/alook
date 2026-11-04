"use client"

import { captureProductAnalytics } from "@/lib/product-analytics"
import { startAction, finishAction } from "@/lib/observability/context"
import { ObservedStaticContent } from "@/lib/observability/regions"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { useHydratedClient } from "@/hooks/use-hydrated-client"
import { signIn, signUp, authClient } from "@/lib/auth-client"
import {
  normalizeLoginMethod,
  rememberLastLoginMethod,
  type LoginMethod,
} from "@/lib/last-login-method"
import { parseRetryAfterSeconds } from "@/lib/retry-after"
import { tid } from "@/lib/community/testids"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  FieldGroup,
  FieldSeparator,
} from "@/components/ui/field"
import { SignInEmailField, SignInOtpField } from "./sign-in-fields"
import { SocialSignIn } from "./social-sign-in"
import { SignInTermsNotice } from "./sign-in-terms"
import { SignInMobileTypewriter } from "./sign-in-mobile-typewriter"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import {
  sceneDurationMs,
  type LandingScene,
} from "@/components/home/landing-shell-motion-timeline"
import galleryStyles from "@/components/home/landing-shell-motion.module.css"
import { DEV_PASSWORD } from "@alook/shared"
import { ArrowLeft, CircleCheck, Mail } from "lucide-react"
import Image from "next/image"
import { safeRedirectPath } from "@/lib/safe-redirect"
import { cn } from "@/lib/utils"

// Default post-login landing when no explicit `?redirect=` is present. Points
// at the community home (/c/me); the old `/workspaces` target was the legacy
// (v0) workspace surface being retired.
const DEFAULT_POST_LOGIN = "/c/me"

function safeRedirectUrl(redirect: string | null): string {
  return safeRedirectPath(redirect, DEFAULT_POST_LOGIN)
}

function readClientLastLoginMethod(): LoginMethod | null {
  const getter = (authClient as { getLastUsedLoginMethod?: () => string | null })
    .getLastUsedLoginMethod
  return normalizeLoginMethod(getter?.())
}

type StepViewState =
  | "methods"
  | "email"
  | "prepare-from-methods"
  | "sliding-from-methods"
  | "prepare-to-methods"
  | "sliding-to-methods"
  | "prepare-to-code"
  | "sliding-to-code"
  | "code"
  | "prepare-to-email"
  | "sliding-to-email"

const STEP_SLIDE_FALLBACK_MS = 560

function SignInForm({
  postLoginUrl,
  isProd,
  accountDeleted,
  accountDeletionPending,
  appleEnabled,
  initialLastUsedMethod = null,
}: {
  postLoginUrl: string
  isProd: boolean
  accountDeleted: boolean
  accountDeletionPending: boolean
  appleEnabled: boolean
  initialLastUsedMethod?: LoginMethod | null
}) {
  const hydrated = useHydratedClient()

  useEffect(() => {
    void captureProductAnalytics({ event: "login_page_view" })
  }, [])

  const failed = (failureStage: "send_code" | "verify_code", error: unknown) => {
    void captureProductAnalytics({
      event: "sign_in_failed",
      method: "email_otp",
      failureStage,
      error,
    })
  }

  const trackRef = useRef<HTMLDivElement>(null)
  const codePaneRef = useRef<HTMLDivElement>(null)
  const [email, setEmail] = useAtom(useCreateAtom(""))
  const [emailError, setEmailError] = useAtom(useCreateAtom(""))
  const [otpError, setOtpError] = useAtom(useCreateAtom(""))
  const [loading, setLoading] = useAtom(useCreateAtom(false))
  const [code, setCode] = useAtom(useCreateAtom(""))
  const [viewState, setViewState] = useAtom(useCreateAtom<StepViewState>("methods"))
  const [retryAfter, setRetryAfter] = useAtom(useCreateAtom<number | null>(null))
  const [lastUsedMethod, setLastUsedMethod] = useAtom(
    useCreateAtom<LoginMethod | null>(initialLastUsedMethod),
  )

  const finishSlide = useCallback(
    (target: "methods" | "email" | "code") => {
      setViewState(target)
    },
    [setViewState],
  )

  const shouldAnimateSlide = () =>
    typeof window !== "undefined"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const switchMethodsStep = (target: "methods" | "email") => {
    if (isTransitioning) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (!shouldAnimateSlide()) {
      setViewState(target)
      return
    }
    setViewState(target === "email" ? "prepare-from-methods" : "prepare-to-methods")
  }

  const enterCodeStep = () => {
    if (!shouldAnimateSlide()) {
      setViewState("code")
      return
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setViewState("prepare-to-code")
  }

  const returnToEmailStep = () => {
    setCode("")
    setOtpError("")
    setEmailError("")
    if (!shouldAnimateSlide()) {
      setViewState("email")
      return
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setViewState("prepare-to-email")
  }

  useEffect(() => {
    const stored = readClientLastLoginMethod()
    if (stored) setLastUsedMethod(stored)
  }, [setLastUsedMethod])

  useEffect(() => {
    if (retryAfter == null) return
    const id = setTimeout(() => {
      setRetryAfter((v) => (v == null || v <= 1 ? null : v - 1))
    }, 1000)
    return () => clearTimeout(id)
  }, [retryAfter, setRetryAfter])

  useEffect(() => {
    if (!viewState.startsWith("prepare-")) return
    void trackRef.current?.getBoundingClientRect()
    const rafId = window.requestAnimationFrame(() => {
      setViewState(
        viewState.replace("prepare-", "sliding-") as StepViewState,
      )
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [setViewState, viewState])

  useEffect(() => {
    if (!viewState.startsWith("sliding-")) return
    const target = viewState === "sliding-to-code" ? "code" : viewState === "sliding-to-methods" ? "methods" : "email"
    const timerId = window.setTimeout(() => {
      finishSlide(target)
    }, STEP_SLIDE_FALLBACK_MS)
    return () => window.clearTimeout(timerId)
  }, [finishSlide, viewState])

  useEffect(() => {
    if (!isProd || viewState !== "code" || loading) return
    const focusOtp = () => {
      const otpInput = codePaneRef.current?.querySelector<HTMLInputElement>(
        'input[aria-label="Verification code"]',
      )
      if (otpInput && document.activeElement !== otpInput) {
        otpInput.focus()
      }
    }
    focusOtp()
    const rafId = window.requestAnimationFrame(focusOtp)
    return () => window.cancelAnimationFrame(rafId)
  }, [isProd, loading, viewState])

  const rateLimitHandler = {
    onError: (ctx: { response: Response }) => {
      if (ctx.response.status === 429) {
        setEmailError("")
        const seconds = parseRetryAfterSeconds(ctx.response.headers)
        if (seconds != null) setRetryAfter(seconds)
      }
    },
  }

  function handleEmailSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    if (!form.reportValidity()) return
    const emailInput = form.elements.namedItem("email")
    if (!(emailInput instanceof HTMLInputElement)) return
    if (isProd) void sendCode(emailInput.value)
    else void devSignIn(emailInput.value)
  }

  async function sendCode(targetEmail: string) {
    if (retryAfter != null) return
    const observation = startAction("auth_send_code")
    setEmailError("")
    setRetryAfter(null)
    setLoading(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: targetEmail,
        type: "sign-in",
        fetchOptions: rateLimitHandler,
      })
      finishAction(observation, error ? "error" : "success")
      if (error) {
        failed("send_code", error)
        if (error.status !== 429) setEmailError(error.message ?? "Failed to send code")
      } else {
        setEmail(targetEmail)
        setEmailError("")
        setOtpError("")
        enterCodeStep()
      }
    } catch (error) {
      finishAction(observation, "error")
      failed("send_code", error)
      setEmailError("Failed to send code")
    }
    setLoading(false)
  }

  async function handleVerifyCode(value: string) {
    setCode(value)
    setOtpError("")
    if (value.length !== 6) return
    await verifyCode(value)
  }

  async function verifyCode(value: string) {
    const observation = startAction("auth_verify_code")
    setLoading(true)
    try {
      const { error } = await authClient.signIn.emailOtp({
        email,
        otp: value,
      })
      finishAction(observation, error ? "error" : "success")
      if (error) {
        failed("verify_code", error)
        setOtpError(error.message ?? "Invalid code")
        setCode("")
      } else {
        rememberLastLoginMethod("email")
        setLastUsedMethod("email")
        setOtpError("")
        window.location.href = postLoginUrl
        return
      }
    } catch (error) {
      finishAction(observation, "error")
      failed("verify_code", error)
      setOtpError("Invalid code")
      setCode("")
    }
    setLoading(false)
  }

  async function devSignIn(targetEmail: string) {
    const observation = startAction("auth_dev_sign_in")
    setEmailError("")
    setLoading(true)
    const { error: signInErr } = await signIn.email(
      { email: targetEmail, password: DEV_PASSWORD },
      { onError: () => {} },
    )
    if (signInErr) {
      const { error: signUpErr } = await signUp.email(
        { name: targetEmail.split("@")[0], email: targetEmail, password: DEV_PASSWORD },
        { onError: () => {} },
      )
      if (signUpErr) {
        finishAction(observation, "error")
        setEmailError(signUpErr.message ?? "Failed to sign in")
        setLoading(false)
        return
      }
    }
    rememberLastLoginMethod("email")
    setLastUsedMethod("email")
    finishAction(observation, "success")
    window.location.href = postLoginUrl
  }

  const isCoolingDown = retryAfter != null
  const emailFeedback = isCoolingDown
    ? `Too many requests. Try again in ${retryAfter}s.`
    : emailError
  const sendLabel = loading
    ? "Sending..."
    : isCoolingDown
    ? `Wait ${retryAfter}s`
    : "Continue"
  const isEmailLastUsed = lastUsedMethod === "email"
  const methodsTransition = viewState.endsWith("methods") && viewState !== "methods"
  const isTransitioning = viewState.startsWith("prepare-") || viewState.startsWith("sliding-")
  const showMethodsPane = viewState === "methods" || methodsTransition
  const showEmailPane = viewState === "email" || isTransitioning
  const showCodePane = isProd && (viewState === "code" || (isTransitioning && !methodsTransition))
  const isSliding = viewState.startsWith("sliding-")
  const isExitingEmail = viewState === "prepare-to-code" || viewState === "sliding-to-code"
    || viewState === "prepare-to-methods" || viewState === "sliding-to-methods"
  const isExitingCode = viewState === "prepare-to-email" || viewState === "sliding-to-email"
  const deferOtpFocus = isTransitioning
  const trackTransform = isTransitioning
    ? viewState === "sliding-to-code" || viewState === "prepare-to-email"
      || viewState === "sliding-from-methods" || viewState === "prepare-to-methods"
      ? "translate3d(-100%, 0, 0)"
      : "translate3d(0%, 0, 0)"
    : undefined

  const handleTrackTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") {
      return
    }
    if (viewState === "sliding-to-code") {
      finishSlide("code")
    } else if (viewState === "sliding-to-methods") {
      finishSlide("methods")
    } else if (viewState === "sliding-to-email" || viewState === "sliding-from-methods") {
      finishSlide("email")
    }
  }

  return (
    <div className="relative flex min-h-0 w-full flex-1 overflow-x-clip sm:min-h-124">
      <ObservedStaticContent />
      <div
        ref={trackRef}
        data-testid={tid.signInStepTrack}
        data-step-view={viewState}
        onTransitionEnd={handleTrackTransitionEnd}
        style={trackTransform ? { transform: trackTransform } : undefined}
        className={cn(
          "flex min-h-0 w-full flex-1",
          isSliding
            && "transition-transform duration-500 ease-in-out will-change-transform motion-reduce:transition-none",
        )}
      >
        {showMethodsPane ? (
          <div aria-hidden={isTransitioning || undefined} inert={isTransitioning || undefined} className="flex min-h-svh w-full shrink-0 flex-col justify-center gap-4 pt-[max(0.5rem,var(--app-safe-area-top))] pb-[max(1rem,var(--app-safe-area-bottom))] sm:min-h-0 sm:p-8">
            <SignInMobileTypewriter collapsed={false} />
            <div className="mx-auto w-full max-w-88 px-4 sm:px-0">
              <FieldGroup className="gap-4">
                  {accountDeleted || accountDeletionPending ? (
                    <div
                      className="flex gap-3 rounded-xl bg-muted/70 p-4 text-left"
                      role="status"
                      data-testid={tid.accountDeletionComplete}
                    >
                      <CircleCheck
                        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <div>
                        <div className="text-sm font-medium">
                          {accountDeletionPending
                            ? "Account deletion requested"
                            : "Account deleted"}
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {accountDeletionPending
                            ? "Sign-in is disabled. We’re stopping billing and removing your data. Cleanup will retry automatically."
                            : "Your account and its data were removed."}
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <h1
                    aria-label="Welcome to Alook"
                    className="mb-0 flex w-full items-center justify-start gap-2 text-left text-[1.375rem] leading-7 font-semibold tracking-tight whitespace-nowrap sm:mb-4 sm:text-2xl sm:leading-8 [@media(min-height:740px)]:mb-4"
                  >
                    <span>Welcome to</span>
                    <Image
                      src="/alook.svg"
                      alt=""
                      width={24}
                      height={24}
                      priority
                      className="size-5.5 shrink-0 sm:size-6"
                    />
                    <span className="font-brand text-[1.5625rem] leading-none font-bold tracking-tight sm:text-[1.6875rem]">
                      Alook
                    </span>
                  </h1>

                  <SocialSignIn
                    postLoginUrl={postLoginUrl}
                    appleEnabled={appleEnabled}
                    lastUsedMethod={lastUsedMethod}
                  />

                  <FieldSeparator className="*:data-[slot=field-separator-content]:text-xs">
                    or
                  </FieldSeparator>

                <div className="relative">
                  <Button variant="outline" size="lg" type="button" aria-describedby={isEmailLastUsed ? "last-used-email-badge" : undefined} className="h-11 w-full justify-start px-4 text-sm font-medium" disabled={!hydrated} onClick={() => switchMethodsStep("email")}>
                    <span className="flex items-center gap-2"><span className="grid h-9 w-6 place-items-center"><Mail className="size-4" aria-hidden /></span>Continue with email</span>
                  </Button>
                  {isEmailLastUsed ? <span id="last-used-email-badge" data-testid="last-used-email" className="pointer-events-none absolute -top-2 right-3 rounded-md border border-border bg-background px-1.5 text-[10px] leading-4 font-medium text-muted-foreground">Last used</span> : null}
                </div>
                <SignInTermsNotice />
              </FieldGroup>
            </div>
          </div>
        ) : null}
        {showEmailPane ? (
          <div
            key="email-pane"
            data-testid="sign-in-email-pane"
            aria-hidden={isExitingEmail || undefined}
            inert={isTransitioning || undefined}
            className="flex min-h-svh w-full shrink-0 flex-col justify-center px-4 pt-[max(1.5rem,var(--app-safe-area-top))] pb-[max(1.5rem,var(--app-safe-area-bottom))] sm:min-h-0 sm:p-8"
          >
            <div className="mx-auto w-full max-w-80 sm:max-w-88">
              <FieldGroup className="gap-4">
                <Button variant="ghost" type="button" className="h-11 w-fit gap-2" disabled={loading || isTransitioning} onClick={() => switchMethodsStep("methods")}>
                  <ArrowLeft className="size-4" aria-hidden />
                  Back
                </Button>
                <h1 className="text-2xl font-semibold tracking-tight">Continue with email</h1>
                <p className="text-sm text-muted-foreground">We’ll send you a sign-in code.</p>
                  <form noValidate onSubmit={handleEmailSubmit}>
                    <fieldset disabled={isTransitioning} className="flex flex-col gap-2">
                      <SignInEmailField
                        email={email}
                        error={isProd ? emailFeedback : emailError}
                        onChange={(event) => {
                          setEmail(event.target.value)
                          setEmailError("")
                        }}
                      />
                      <div className="relative">
                        <Button
                          variant="outline"
                          size="lg"
                          type="submit"
                          disabled={loading || isTransitioning || (isProd && isCoolingDown)}
                          className="h-11 w-full justify-center px-4 text-sm font-medium"
                        >
                          {isProd ? sendLabel : loading ? "Signing in..." : "Sign in"}
                        </Button>

                      </div>
                    </fieldset>
                  </form>
              </FieldGroup>
            </div>
          </div>
        ) : null}

        {showCodePane ? (
          <div
            key="code-pane"
            ref={codePaneRef}
            data-testid="sign-in-code-pane"
            aria-hidden={isExitingCode || undefined}
            inert={isTransitioning || undefined}
            className="flex min-h-svh w-full shrink-0 flex-col justify-center px-4 pt-[max(1.5rem,var(--app-safe-area-top))] pb-[max(1.5rem,var(--app-safe-area-bottom))] sm:min-h-0 sm:p-8"
          >
            <div className="mx-auto w-full max-w-80 sm:max-w-88">
              <FieldGroup className="gap-4">
                <div className="mb-4 flex flex-col items-center gap-2 text-center sm:mb-0 [@media(max-height:579px)]:mb-0">
                  <Logo size="lg" iconOnly className="size-11 justify-center rounded-lg" />
                  <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                    Check your email
                  </h1>
                  <p className="max-w-full wrap-break-word text-sm text-muted-foreground">
                    We sent a code to{" "}
                    <strong className="font-medium text-foreground">{email}</strong>
                  </p>
                </div>
                <SignInOtpField
                  code={code}
                  error={otpError}
                  loading={loading || isTransitioning}
                  autoFocus={!deferOtpFocus}
                  onChange={handleVerifyCode}
                />
                <Button
                  variant="ghost"
                  type="button"
                  className="h-11 w-full sm:h-9"
                  disabled={isTransitioning}
                  onClick={returnToEmailStep}
                >
                  Use a different email
                </Button>
              </FieldGroup>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const galleryScenes: { scene: LandingScene; label: string; description: string }[] = [
  {
    scene: "server",
    label: "The best room for agents and humans",
    description: "Bring your people and agents together in one shared home.",
  },
  {
    scene: "spaces",
    label: "A room for every part of life",
    description: "Keep work, life, and play separate—invite the friends and bots who belong.",
  },
  {
    scene: "machine",
    label: "Bring your own agents",
    description: "Use your own computer and existing agent subscriptions.",
  },
  {
    scene: "provider",
    label: "Persistent identity and memory",
    description: "Your agents stay themselves, independent of provider.",
  },
]

function ProductGallery() {
  const [active, setActive] = useAtom(useCreateAtom(0))
  const [enabled, setEnabled] = useAtom(useCreateAtom(false))
  const [autoAdvance, setAutoAdvance] = useAtom(useCreateAtom(true))
  const activeScene = galleryScenes[active]

  useEffect(() => {
    const viewport = window.matchMedia("(min-width: 640px)")
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => {
      setEnabled(viewport.matches)
      setAutoAdvance(!reducedMotion.matches)
    }
    sync()
    viewport.addEventListener("change", sync)
    reducedMotion.addEventListener("change", sync)
    return () => {
      viewport.removeEventListener("change", sync)
      reducedMotion.removeEventListener("change", sync)
    }
  }, [setAutoAdvance, setEnabled])

  useEffect(() => {
    if (!enabled || !autoAdvance) return
    const timeout = window.setTimeout(() => {
      setActive((index) => (index + 1) % galleryScenes.length)
    }, sceneDurationMs(activeScene.scene))
    return () => window.clearTimeout(timeout)
  }, [activeScene.scene, autoAdvance, enabled, setActive])

  if (!enabled) return null

  return (
    <div className={`${galleryStyles.galleryContainer} flex h-full min-h-0 flex-col items-center justify-center p-4 lg:p-8`}>
      <div
        className={`${galleryStyles.galleryFrame} w-full bg-background ring-1 ring-border/60 shadow-lg`}
        role="img"
        aria-label={activeScene.label}
      >
        <LandingShellMotion
          key={activeScene.scene}
          scene={activeScene.scene}
        />
      </div>
      <div className={`${galleryStyles.galleryFooter} mt-4`}>
        <div aria-live="polite">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {String(active + 1).padStart(2, "0")} / {String(galleryScenes.length).padStart(2, "0")}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {activeScene.label}
          </p>
          <p className="mt-0.5 max-w-lg text-xs leading-relaxed text-muted-foreground">
            {activeScene.description}
          </p>
        </div>
        <div className={galleryStyles.gallerySwitcher} aria-label="Product stories">
          {galleryScenes.map((item, i) => (
            <Button variant="ghost" size="icon"
              key={item.scene}
              onClick={() => setActive(i)}
              className="grid size-8 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Show ${item.label}`}
              aria-pressed={i === active}
            >
              <span
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: i === active ? 16 : 6,
                  backgroundColor: i === active
                    ? "var(--foreground)"
                    : "var(--muted-foreground)",
                  opacity: i === active ? 1 : 0.3,
                }}
              />
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function SignInPageClient({
  isProd,
  appleEnabled,
  initialLastUsedMethod = null,
}: {
  isProd: boolean
  appleEnabled: boolean
  initialLastUsedMethod?: LoginMethod | null
}) {
  const searchParams = useSearchParams()
  const postLoginUrl = safeRedirectUrl(searchParams.get("redirect"))
  const accountDeleted = searchParams.get("account_deleted") === "1"
  const accountDeletionPending = searchParams.get("account_deleted") === "pending"

  return (
    <div
      data-slot="auth-page"
      className="relative flex min-h-svh flex-col p-0 sm:items-center sm:justify-center sm:p-8"
    >
      <GradientBackground />
      <div className="flex min-h-0 w-full flex-1 flex-col sm:max-w-5xl sm:flex-none">
        <Card className="min-h-0 flex-1 overflow-visible rounded-none bg-transparent p-0 shadow-none ring-0 sm:flex-none sm:overflow-hidden sm:rounded-xl sm:bg-card sm:ring-1 sm:ring-foreground/10">
          <CardContent className="flex min-h-0 flex-1 flex-col p-0 sm:grid sm:flex-none sm:grid-cols-[minmax(352px,0.88fr)_minmax(0,1.25fr)]">
            <SignInForm
              postLoginUrl={postLoginUrl}
              isProd={isProd}
              accountDeleted={accountDeleted}
              accountDeletionPending={accountDeletionPending}
              appleEnabled={appleEnabled}
              initialLastUsedMethod={initialLastUsedMethod}
            />
            <div className="relative hidden min-h-124 overflow-hidden bg-muted sm:block">
              <ProductGallery />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
