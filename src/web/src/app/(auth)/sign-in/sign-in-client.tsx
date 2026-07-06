"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
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
import { DEV_PASSWORD } from "@alook/shared"

const DEFAULT_POST_LOGIN = "/workspaces?auto"

function safeRedirectUrl(redirect: string | null): string {
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
    return redirect
  }
  return DEFAULT_POST_LOGIN
}

function SignInForm({ postLoginUrl, isProd }: { postLoginUrl: string; isProd: boolean }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

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
        if (error.status !== 429) setError(error.message ?? t("failedToSend"))
      } else {
        setStep("code")
      }
    } catch {
      setError(t("failedToSend"))
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
        setError(error.message ?? t("invalidCode"))
        setCode("")
      } else {
        window.location.href = postLoginUrl
        return
      }
    } catch {
      setError(t("invalidCode"))
      setCode("")
    }
    setLoading(false)
  }

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
        setError(signUpErr.message ?? t("failedToSignIn"))
        setLoading(false)
        return
      }
    }
    window.location.href = postLoginUrl
  }

  const isCoolingDown = retryAfter != null
  const sendLabel = loading
    ? t("sending")
    : isCoolingDown
    ? t("waitSeconds", { seconds: retryAfter })
    : t("sendCode")

  const subtitle = isProd && step === "code"
    ? t("enterCode")
    : isProd
    ? t("enterEmailPrompt")
    : undefined

  return (
    <FieldGroup>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">{t("signIn")}</h1>
        <p className="text-sm text-muted-foreground">{t("orCreate")}</p>
        {subtitle && (
          <p className="text-balance text-muted-foreground">{subtitle}</p>
        )}
      </div>

      {isCoolingDown && (
        <FieldError>
          {t("tooManyRequests", { seconds: retryAfter })}
        </FieldError>
      )}
      {error && !isCoolingDown && <FieldError>{error}</FieldError>}

      {isProd ? (
        step === "email" ? (
          <form onSubmit={handleSendCode}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder={t("emailPlaceholder")}
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
              {t("codeSentTo")} <strong>{email}</strong>
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
              {t("useDifferentEmail")}
            </Button>
          </>
        )
      ) : (
        <form onSubmit={handleDevSignIn}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? t("signingIn") : t("signIn")}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}

      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
        {t("orContinue")}
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
  { src: "/gallery/collaboration.png", labelKey: "dashboard" as const, subKey: "collaboration" },
  { src: "/gallery/email.png", labelKey: "dashboard" as const, subKey: "inbox" },
  { src: "/gallery/issues.png", labelKey: "dashboard" as const, subKey: "kanban" },
  { src: "/gallery/calendar.png", labelKey: "dashboard" as const, subKey: "calendar" },
  { src: "/gallery/local-agent.png", labelKey: "common" as const, subKey: "agent" },
]

function ProductGallery() {
  const t = useTranslations();
  const [active, setActive] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setActive((i) => (i + 1) % galleryImages.length)
    }, 3500)
    return () => clearInterval(interval)
  }, [])

  const label = (img: typeof galleryImages[number]) =>
    img.labelKey === "dashboard"
      ? t(`dashboard.${img.subKey}` as any)
      : t(`common.${img.subKey}` as any)

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="relative w-full rounded-lg overflow-hidden shadow-lg">
        {galleryImages.map((img, i) => (
          <Image
            key={img.src}
            src={img.src}
            alt={label(img)}
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
        {label(galleryImages[active])}
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
            aria-label={`Show ${label(galleryImages[i])}`}
          />
        ))}
      </div>
    </div>
  )
}

export default function SignInPageClient({ isProd }: { isProd: boolean }) {
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
                <SignInForm postLoginUrl={postLoginUrl} isProd={isProd} />
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
