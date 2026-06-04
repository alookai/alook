"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { signIn, signUp, authClient } from "@/lib/auth-client"
import { parseRetryAfterSeconds } from "@/lib/retry-after"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"
import Image from "next/image"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { resolveMode, DEV_PASSWORD } from "@alook/shared"

const mode = resolveMode({
  nodeEnv: process.env.NODE_ENV,
  hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
})
const isProd = mode === "production"

const DEFAULT_POST_LOGIN = "/workspaces?auto"

function safeRedirectUrl(redirect: string | null): string {
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
    return redirect
  }
  return DEFAULT_POST_LOGIN
}

function SignInForm({ postLoginUrl }: { postLoginUrl: string }) {
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  // OTP-specific state
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"email" | "code">("email")
  const [retryAfter, setRetryAfter] = useState<number | null>(null)

  useEffect(() => {
    if (retryAfter == null) return
    const id = setTimeout(() => {
      setRetryAfter((v) => (v == null || v <= 1 ? null : v - 1))
    }, 1000)
    return () => clearTimeout(id)
  }, [retryAfter])

  const rateLimitHandler = {
    onError: (ctx: { response: Response }) => {
      if (ctx.response.status === 429) {
        const seconds = parseRetryAfterSeconds(ctx.response.headers)
        if (seconds != null) setRetryAfter(seconds)
      }
    },
  }

  // OTP handlers
  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    if (retryAfter != null) return
    setError("")
    setRetryAfter(null)
    setLoading(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
        fetchOptions: rateLimitHandler,
      })
      if (error) {
        if (error.status !== 429) setError(error.message ?? "Failed to send code")
      } else {
        setStep("code")
      }
    } catch {
      setError("Failed to send code")
    }
    setLoading(false)
  }

  async function handleVerifyCode(value: string) {
    setCode(value)
    if (value.length !== 6) return

    setError("")
    setLoading(true)
    try {
      const { error } = await authClient.signIn.emailOtp({
        email,
        otp: value,
      })
      if (error) {
        setError(error.message ?? "Invalid code")
        setCode("")
      } else {
        window.location.href = postLoginUrl
        return
      }
    } catch {
      setError("Invalid code")
      setCode("")
    }
    setLoading(false)
  }

  // Dev mode: sign in/up with a fixed password, no user input needed
  async function handleDevSignIn(e: React.FormEvent) {
    e.preventDefault()
    setError("")
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
        setError(signUpErr.message ?? "Failed to sign in")
        setLoading(false)
        return
      }
    }
    window.location.href = postLoginUrl
  }

  const isCoolingDown = retryAfter != null
  const sendLabel = loading
    ? "Sending..."
    : isCoolingDown
    ? `Wait ${retryAfter}s`
    : "Send Code"

  const subtitle = isProd && step === "code"
    ? "Enter the code we sent you"
    : isProd
    ? "Enter your email \u2014 we\u2019ll send you a verification code"
    : undefined

  return (
    <FieldGroup>
      {/* Header */}
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Sign in</h1>
        <p className="text-sm text-muted-foreground">or create an account to get started</p>
        {subtitle && (
          <p className="text-balance text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {/* Error */}
      {isCoolingDown && (
        <FieldError>
          Too many requests. Try again in {retryAfter}s.
        </FieldError>
      )}
      {error && !isCoolingDown && <FieldError>{error}</FieldError>}

      {/* Credential form */}
      {isProd ? (
        step === "email" ? (
          <form onSubmit={handleSendCode}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <Button
                  type="submit"
                  disabled={loading || isCoolingDown}
                  className="w-full"
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
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={handleVerifyCode}
                disabled={loading}
                autoFocus
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setStep("email")
                setCode("")
                setError("")
              }}
            >
              Use a different email
            </Button>
          </>
        )
      ) : (
        <form onSubmit={handleDevSignIn}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}

      {/* Social login */}
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
        Or continue with
      </FieldSeparator>
      <Field className="grid grid-cols-2 gap-4">
        <Button
          variant="outline"
          type="button"
          onClick={() =>
            signIn.social({ provider: "github", callbackURL: postLoginUrl })
          }
        >
          <SiGithub className="size-4" />
          GitHub
        </Button>
        <Button
          variant="outline"
          type="button"
          onClick={() =>
            signIn.social({ provider: "google", callbackURL: postLoginUrl })
          }
        >
          <SiGoogle className="size-4" />
          Google
        </Button>
      </Field>
    </FieldGroup>
  )
}

const galleryImages = [
  { src: "/gallery/collaboration.png", label: "Collaboration" },
  { src: "/gallery/email.png", label: "Email Inbox" },
  { src: "/gallery/issues.png", label: "Kanban Board" },
  { src: "/gallery/calendar.png", label: "Calendar" },
  { src: "/gallery/local-agent.png", label: "Local Agent" },
]

function ProductGallery() {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setActive((i) => (i + 1) % galleryImages.length)
    }, 3500)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="relative w-full rounded-lg overflow-hidden shadow-lg">
        {galleryImages.map((img, i) => (
          <Image
            key={img.src}
            src={img.src}
            alt={img.label}
            width={600}
            height={450}
            className="w-full h-auto transition-opacity duration-500"
            style={{
              opacity: i === active ? 1 : 0,
              position: i === 0 ? "relative" : "absolute",
              top: 0,
              left: 0,
            }}
            priority={i === 0}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground font-medium tracking-wide">
        {galleryImages[active].label}
      </p>
      <div className="mt-2 flex gap-1.5">
        {galleryImages.map((_, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className="h-1.5 rounded-full transition-all duration-300"
            style={{
              width: i === active ? 16 : 6,
              backgroundColor: i === active
                ? "var(--foreground)"
                : "var(--muted-foreground)",
              opacity: i === active ? 1 : 0.3,
            }}
            aria-label={`Show ${galleryImages[i].label}`}
          />
        ))}
      </div>
    </div>
  )
}

export default function SignInPage() {
  const searchParams = useSearchParams()
  const postLoginUrl = safeRedirectUrl(searchParams.get("redirect"))

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <GradientBackground />
      <div className="w-full max-w-sm md:max-w-4xl">
        <div className="flex flex-col gap-6">
          <div className="flex justify-center mb-2">
            <Logo size="lg" />
          </div>
          <Card className="overflow-hidden p-0">
            <CardContent className="grid p-0 md:grid-cols-2">
              <div className="p-6 md:p-8 md:min-h-105 flex flex-col justify-center">
                <SignInForm postLoginUrl={postLoginUrl} />
              </div>
              <div className="hidden bg-muted md:block relative overflow-hidden min-h-105">
                <ProductGallery />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
