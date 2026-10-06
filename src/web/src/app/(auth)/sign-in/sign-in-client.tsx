"use client"

import { startAction, finishAction } from "@/lib/observability/context"
import { ObservedStaticContent } from "@/lib/observability/regions"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { signIn, signUp, authClient } from "@/lib/auth-client"
import { parseRetryAfterSeconds } from "@/lib/retry-after"
import { tid } from "@/lib/community/testids"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldGroup,
  FieldSeparator,
} from "@/components/ui/field"
import { SignInEmailField, SignInOtpField } from "./sign-in-fields"
import { SocialSignIn } from "./social-sign-in"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import {
  sceneDurationMs,
  type LandingScene,
} from "@/components/home/landing-shell-motion-timeline"
import galleryStyles from "@/components/home/landing-shell-motion.module.css"
import { DEV_PASSWORD } from "@alook/shared"
import { CircleCheck } from "lucide-react"
import { safeRedirectPath } from "@/lib/safe-redirect"

// Default post-login landing when no explicit `?redirect=` is present. Points
// at the community home (/c/me); the old `/workspaces` target was the legacy
// (v0) workspace surface being retired.
const DEFAULT_POST_LOGIN = "/c/me"

function safeRedirectUrl(redirect: string | null): string {
  return safeRedirectPath(redirect, DEFAULT_POST_LOGIN)
}

function SignInForm({
  postLoginUrl,
  isProd,
  accountDeleted,
  appleEnabled,
}: {
  postLoginUrl: string
  isProd: boolean
  accountDeleted: boolean
  appleEnabled: boolean
}) {
  const [email, setEmail] = useAtom(useCreateAtom(""))
  const [emailError, setEmailError] = useAtom(useCreateAtom(""))
  const [otpError, setOtpError] = useAtom(useCreateAtom(""))
  const [loading, setLoading] = useAtom(useCreateAtom(false))

  const [code, setCode] = useAtom(useCreateAtom(""))
  const [step, setStep] = useAtom(useCreateAtom<"email" | "code">("email"))
  const [retryAfter, setRetryAfter] = useAtom(useCreateAtom<number | null>(null))

  useEffect(() => {
    if (retryAfter == null) return
    const id = setTimeout(() => {
      setRetryAfter((v) => (v == null || v <= 1 ? null : v - 1))
    }, 1000)
    return () => clearTimeout(id)
  }, [retryAfter, setRetryAfter])

  const rateLimitHandler = {
    onError: (ctx: { response: Response }) => {
      if (ctx.response.status === 429) {
        setEmailError("")
        const seconds = parseRetryAfterSeconds(ctx.response.headers)
        if (seconds != null) setRetryAfter(seconds)
      }
    },
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    if (retryAfter != null) return
    const observation = startAction("auth_send_code")
    setEmailError("")
    setRetryAfter(null)
    setLoading(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
        fetchOptions: rateLimitHandler,
      })
      finishAction(observation, error ? "error" : "success")
      if (error) {
        if (error.status !== 429) setEmailError(error.message ?? "Failed to send code")
      } else {
        setEmailError("")
        setOtpError("")
        setStep("code")
      }
    } catch {
      finishAction(observation, "error")
      setEmailError("Failed to send code")
    }
    setLoading(false)
  }

  async function handleVerifyCode(value: string) {
    setCode(value)
    setOtpError("")
    if (value.length !== 6) return
    const observation = startAction("auth_verify_code")

    setLoading(true)
    try {
      const { error } = await authClient.signIn.emailOtp({
        email,
        otp: value,
      })
      finishAction(observation, error ? "error" : "success")
      if (error) {
        setOtpError(error.message ?? "Invalid code")
        setCode("")
      } else {
        setOtpError("")
        window.location.href = postLoginUrl
        return
      }
    } catch {
      finishAction(observation, "error")
      setOtpError("Invalid code")
      setCode("")
    }
    setLoading(false)
  }

  async function handleDevSignIn(e: React.FormEvent) {
    e.preventDefault()
    const observation = startAction("auth_dev_sign_in")
    setEmailError("")
    setLoading(true)
    const { error: signInErr } = await signIn.email(
      { email, password: DEV_PASSWORD },
      { onError: () => {} },
    )
    if (signInErr) {
      const { error: signUpErr } = await signUp.email(
        { name: email.split("@")[0], email, password: DEV_PASSWORD },
        { onError: () => {} },
      )
      if (signUpErr) {
        finishAction(observation, "error")
        setEmailError(signUpErr.message ?? "Failed to sign in")
        setLoading(false)
        return
      }
    }
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
    : "Send Code"

  const subtitle = isProd && step === "code"
    ? "Enter the code we sent you"
    : isProd
    ? "Enter your email — we’ll send you a verification code"
    : undefined

  return (
    <FieldGroup>
      <ObservedStaticContent />
      {accountDeleted ? (
        <div
          className="flex gap-3 rounded-xl bg-muted/70 p-4 text-left"
          role="status"
          data-testid={tid.accountDeletionComplete}
        >
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="text-sm font-medium">Account deleted</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your account and its data were removed.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Sign in</h1>
        <p className="text-sm text-muted-foreground">or create an account to get started</p>
        {subtitle && (
          <p className="text-balance text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {isProd ? (
        step === "email" ? (
          <form onSubmit={handleSendCode}>
            <FieldGroup>
              <SignInEmailField
                email={email}
                error={emailFeedback}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setEmailError("")
                }}
              />
              <Field>
                <Button
                  variant="outline"
                  size="lg"
                  type="submit"
                  disabled={loading || isCoolingDown}
                  className="w-full text-base"
                >
                  {sendLabel}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted-foreground text-center">
              We sent a code to <strong>{email}</strong>
            </p>
            <SignInOtpField
              code={code}
              error={otpError}
              loading={loading}
              onChange={handleVerifyCode}
            />
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setStep("email")
                setCode("")
                setOtpError("")
                setEmailError("")
              }}
            >
              Use a different email
            </Button>
          </>
        )
      ) : (
        <form onSubmit={handleDevSignIn}>
          <FieldGroup>
            <SignInEmailField
              email={email}
              error={emailError}
              onChange={(event) => {
                setEmail(event.target.value)
                setEmailError("")
              }}
            />
            <Field>
              <Button
                variant="outline"
                size="lg"
                type="submit"
                disabled={loading}
                className="w-full text-base"
              >
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}

      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
        Or continue with
      </FieldSeparator>
      <SocialSignIn postLoginUrl={postLoginUrl} appleEnabled={appleEnabled} />
    </FieldGroup>
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
    <div className={`${galleryStyles.galleryContainer} flex h-full min-h-0 flex-col items-center justify-center p-5 lg:p-7`}>
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
}: {
  isProd: boolean
  appleEnabled: boolean
}) {
  const searchParams = useSearchParams()
  const postLoginUrl = safeRedirectUrl(searchParams.get("redirect"))
  const accountDeleted = searchParams.get("account_deleted") === "1"

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6 sm:p-10">
      <GradientBackground />
      <div className="w-full max-w-sm sm:max-w-6xl">
        <div className="flex flex-col gap-6">
          <div className="flex justify-center mb-2">
            <Logo size="lg" />
          </div>
          <Card className="overflow-hidden p-0">
            <CardContent className="grid p-0 sm:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.35fr)]">
              <div className="flex flex-col justify-center p-6 sm:min-h-120 sm:p-8">
                <SignInForm
                  postLoginUrl={postLoginUrl}
                  isProd={isProd}
                  accountDeleted={accountDeleted}
                  appleEnabled={appleEnabled}
                />
              </div>
              <div className="relative hidden min-h-120 overflow-hidden bg-muted sm:block">
                <ProductGallery />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
