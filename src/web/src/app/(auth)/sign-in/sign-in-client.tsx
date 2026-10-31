"use client"

import { captureProductAnalytics } from "@/lib/product-analytics"
import { startAction, finishAction } from "@/lib/observability/context"
import { ObservedStaticContent } from "@/lib/observability/regions"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "next/navigation"
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
import { useIsMobile } from "@/hooks/use-mobile"
import { Logo } from "@/components/logo"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import {
  sceneDurationMs,
  type LandingScene,
} from "@/components/home/landing-shell-motion-timeline"
import galleryStyles from "@/components/home/landing-shell-motion.module.css"
import { DEV_PASSWORD } from "@alook/shared"
import { CircleCheck, Mail } from "lucide-react"
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
  | "email"
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
  isMobile,
  mobileTypewriterCollapsed,
  onSlideActiveChange,
}: {
  postLoginUrl: string
  isProd: boolean
  accountDeleted: boolean
  accountDeletionPending: boolean
  appleEnabled: boolean
  initialLastUsedMethod?: LoginMethod | null
  isMobile: boolean
  mobileTypewriterCollapsed: boolean
  onSlideActiveChange?: (active: boolean) => void
}) {
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
  const [viewState, setViewState] = useAtom(useCreateAtom<StepViewState>("email"))
  const [retryAfter, setRetryAfter] = useAtom(useCreateAtom<number | null>(null))
  const [lastUsedMethod, setLastUsedMethod] = useAtom(
    useCreateAtom<LoginMethod | null>(initialLastUsedMethod),
  )

  const finishSlide = useCallback(
    (target: "email" | "code") => {
      onSlideActiveChange?.(false)
      setViewState(target)
    },
    [onSlideActiveChange, setViewState],
  )

  const shouldAnimateSlide = () =>
    isMobile
    && typeof window !== "undefined"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches

  const enterCodeStep = () => {
    if (!shouldAnimateSlide()) {
      setViewState("code")
      return
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    onSlideActiveChange?.(true)
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
    onSlideActiveChange?.(true)
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
    if (viewState !== "prepare-to-code" && viewState !== "prepare-to-email") return
    void trackRef.current?.getBoundingClientRect()
    const rafId = window.requestAnimationFrame(() => {
      setViewState(
        viewState === "prepare-to-code" ? "sliding-to-code" : "sliding-to-email",
      )
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [setViewState, viewState])

  useEffect(() => {
    if (viewState !== "sliding-to-code" && viewState !== "sliding-to-email") return
    const target = viewState === "sliding-to-code" ? "code" : "email"
    const timerId = window.setTimeout(() => {
      finishSlide(target)
    }, STEP_SLIDE_FALLBACK_MS)
    return () => window.clearTimeout(timerId)
  }, [finishSlide, viewState])

  useEffect(() => {
    if (isMobile) return
    if (viewState === "prepare-to-code" || viewState === "sliding-to-code") {
      finishSlide("code")
    } else if (viewState === "prepare-to-email" || viewState === "sliding-to-email") {
      finishSlide("email")
    }
  }, [finishSlide, isMobile, viewState])

  useEffect(() => {
    if (!isProd || viewState !== "code") return
    const focusOtp = () => {
      const otpInput = codePaneRef.current?.querySelector<HTMLInputElement>(
        'input[aria-label="Verification code"]',
      )
      if (otpInput && document.activeElement !== otpInput) {
        otpInput.focus({ preventScroll: true })
      }
    }
    focusOtp()
    const rafId = window.requestAnimationFrame(focusOtp)
    return () => window.cancelAnimationFrame(rafId)
  }, [isProd, viewState])

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
        rememberLastLoginMethod("email")
        setLastUsedMethod("email")
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
    : "Continue with email"
  const isEmailLastUsed = lastUsedMethod === "email"
  const showEmailPane = !isProd || viewState !== "code"
  const showCodePane = isProd && viewState !== "email"
  const isSliding = viewState === "sliding-to-code" || viewState === "sliding-to-email"
  const isExitingEmail =
    viewState === "prepare-to-code" || viewState === "sliding-to-code"
  const isExitingCode =
    viewState === "prepare-to-email" || viewState === "sliding-to-email"
  const deferOtpFocus =
    viewState === "prepare-to-code" || viewState === "sliding-to-code"
  const trackTransform =
    viewState === "sliding-to-code" || viewState === "prepare-to-email"
      ? "translate3d(-100%, 0, 0)"
      : viewState === "prepare-to-code" || viewState === "sliding-to-email"
      ? "translate3d(0%, 0, 0)"
      : undefined

  const handleTrackTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") {
      return
    }
    if (viewState === "sliding-to-code") {
      finishSlide("code")
    } else if (viewState === "sliding-to-email") {
      finishSlide("email")
    }
  }

  return (
    <div className="relative flex min-h-0 w-full flex-1 overflow-clip sm:min-h-124">
      <ObservedStaticContent />
      <div
        ref={trackRef}
        data-testid="sign-in-step-track"
        data-step-view={viewState}
        onTransitionEnd={handleTrackTransitionEnd}
        style={trackTransform ? { transform: trackTransform } : undefined}
        className={cn(
          "flex min-h-0 w-full flex-1",
          isSliding
            && "transition-transform duration-500 ease-in-out will-change-transform motion-reduce:transition-none",
        )}
      >
        {showEmailPane ? (
          <div
            key="email-pane"
            data-testid="sign-in-email-pane"
            aria-hidden={isExitingEmail || undefined}
            inert={isExitingEmail || undefined}
            className={cn(
              "flex h-full min-h-0 w-full shrink-0 flex-col sm:h-auto sm:justify-center sm:overflow-visible sm:p-8",
              mobileTypewriterCollapsed
                ? "overflow-y-auto py-4"
                : "justify-center gap-4 overflow-hidden pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] [@media(min-height:740px)]:gap-8",
            )}
          >
            <SignInMobileTypewriter collapsed={mobileTypewriterCollapsed} />
            <div
              className={cn(
                "w-full shrink-0 px-4 sm:px-0",
                mobileTypewriterCollapsed && "my-auto sm:my-0",
              )}
            >
              <div className="mx-auto w-full max-w-80 sm:max-w-88">
                <FieldGroup className="gap-4 sm:gap-4 [@media(max-height:579px)]:gap-2">
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
                    onSelectMethod={setLastUsedMethod}
                  />

                  <FieldSeparator className="*:data-[slot=field-separator-content]:bg-background *:data-[slot=field-separator-content]:text-xs sm:*:data-[slot=field-separator-content]:bg-card">
                    or
                  </FieldSeparator>

                  <form noValidate onSubmit={handleEmailSubmit}>
                    <div className="flex flex-col gap-2">
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
                          disabled={loading || isSliding || (isProd && isCoolingDown)}
                          aria-describedby={
                            isEmailLastUsed ? "last-used-email-badge" : undefined
                          }
                          className={cn(
                            "peer h-11 w-full justify-start px-4 text-sm font-medium",
                            isEmailLastUsed && "pr-22",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="grid h-9 w-6 shrink-0 place-items-center"
                              aria-hidden
                            >
                              <Mail className="size-4" aria-hidden />
                            </span>
                            <span className="truncate">
                              {isProd ? sendLabel : loading ? "Signing in..." : "Sign in"}
                            </span>
                          </span>
                        </Button>
                        {isEmailLastUsed ? (
                          <span
                            id="last-used-email-badge"
                            data-testid="last-used-email"
                            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] leading-none font-medium text-secondary-foreground peer-disabled:opacity-50"
                          >
                            Last used
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </form>

                  <SignInTermsNotice />
                </FieldGroup>
              </div>
            </div>
          </div>
        ) : null}

        {showCodePane ? (
          <div
            key="code-pane"
            ref={codePaneRef}
            data-testid="sign-in-code-pane"
            aria-hidden={isExitingCode || undefined}
            inert={isExitingCode || undefined}
            className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-y-auto px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:h-auto sm:justify-center sm:overflow-visible sm:p-8"
          >
            <div className="mx-auto my-auto w-full max-w-80 sm:my-0 sm:max-w-88">
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
                  loading={loading}
                  autoFocus={!deferOtpFocus}
                  onChange={handleVerifyCode}
                />
                <Button
                  variant="ghost"
                  type="button"
                  className="h-11 w-full sm:h-9"
                  disabled={isSliding}
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
            <button
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
            </button>
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
  const isMobile = useIsMobile()
  const mobileSlideActiveRef = useRef(false)
  const syncViewportRef = useRef<(() => void) | null>(null)
  const [mobileTypewriterCollapsed, setMobileTypewriterCollapsed] = useAtom(
    useCreateAtom(false),
  )
  const [mobileViewportHeight, setMobileViewportHeight] = useAtom(
    useCreateAtom<number | null>(null),
  )

  const handleSlideActiveChange = useCallback((active: boolean) => {
    mobileSlideActiveRef.current = active
    if (!active) {
      syncViewportRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!isMobile) {
      mobileSlideActiveRef.current = false
      syncViewportRef.current = null
      setMobileTypewriterCollapsed(false)
      setMobileViewportHeight(null)
      return
    }
    let inputFocused = false
    const syncViewport = () => {
      if (mobileSlideActiveRef.current) return
      const layoutHeight = window.innerHeight
      const visualHeight = window.visualViewport?.height ?? layoutHeight
      const keyboardLikelyOpen = layoutHeight - visualHeight > 80
      const shortSpace = visualHeight < 580 || (inputFocused && visualHeight < 700)
      setMobileTypewriterCollapsed(keyboardLikelyOpen || shortSpace)
      setMobileViewportHeight(
        keyboardLikelyOpen ? Math.round(visualHeight) : null,
      )
    }
    syncViewportRef.current = syncViewport
    const onFocusIn = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
      ) {
        inputFocused = true
        syncViewport()
      }
    }
    const onFocusOut = () => {
      inputFocused = false
      window.setTimeout(syncViewport, 50)
    }
    syncViewport()
    window.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("resize", syncViewport)
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    return () => {
      syncViewportRef.current = null
      window.removeEventListener("resize", syncViewport)
      window.visualViewport?.removeEventListener("resize", syncViewport)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
    }
  }, [isMobile, setMobileTypewriterCollapsed, setMobileViewportHeight])

  return (
    <div
      style={
        isMobile && mobileViewportHeight !== null
          ? { height: `${mobileViewportHeight}px` }
          : undefined
      }
      className="relative flex h-dvh flex-col overflow-hidden p-0 sm:h-auto sm:min-h-svh sm:items-center sm:justify-center sm:overflow-visible sm:p-8"
    >
      <GradientBackground />
      <div className="flex min-h-0 w-full flex-1 flex-col sm:max-w-5xl sm:flex-none">
        <Card className="min-h-0 flex-1 overflow-hidden rounded-none bg-transparent p-0 shadow-none ring-0 sm:flex-none sm:rounded-xl sm:bg-card sm:ring-1 sm:ring-foreground/10">
          <CardContent className="flex min-h-0 flex-1 flex-col p-0 sm:grid sm:flex-none sm:grid-cols-[minmax(352px,0.88fr)_minmax(0,1.25fr)]">
            <SignInForm
              postLoginUrl={postLoginUrl}
              isProd={isProd}
              accountDeleted={accountDeleted}
              accountDeletionPending={accountDeletionPending}
              appleEnabled={appleEnabled}
              initialLastUsedMethod={initialLastUsedMethod}
              isMobile={isMobile}
              mobileTypewriterCollapsed={mobileTypewriterCollapsed}
              onSlideActiveChange={handleSlideActiveChange}
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
