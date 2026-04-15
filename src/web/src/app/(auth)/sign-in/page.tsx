"use client"

import { useState } from "react"
import { signIn, signUp, authClient } from "@/lib/auth-client"
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
import { GradientBackground } from "@/components/gradient-background"
import { TypewriterVisual } from "@/components/typewriter-visual"

const isProd = process.env.NODE_ENV === "production"

function OTPSignIn() {
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"email" | "code">("email")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      })
      if (error) {
        setError(error.message ?? "Failed to send code")
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
        window.location.href = "/workspaces?auto"
        return
      }
    } catch {
      setError("Invalid code")
      setCode("")
    }
    setLoading(false)
  }

  return (
    <FieldGroup>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="text-balance text-muted-foreground">
          {step === "email"
            ? "We\u2019ll send a verification code to your inbox"
            : "Enter the code we sent you"}
        </p>
      </div>
      {error && <FieldError>{error}</FieldError>}
      {step === "email" ? (
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
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Sending..." : "Send Code"}
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
      )}
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
        Or continue with
      </FieldSeparator>
      <Field className="grid grid-cols-2 gap-4">
        <Button
          variant="outline"
          type="button"
          onClick={() =>
            signIn.social({ provider: "github", callbackURL: "/workspaces?auto" })
          }
        >
          <SiGithub className="size-4" />
          GitHub
        </Button>
        <Button
          variant="outline"
          type="button"
          onClick={() =>
            signIn.social({ provider: "google", callbackURL: "/workspaces?auto" })
          }
        >
          <SiGoogle className="size-4" />
          Google
        </Button>
      </Field>
    </FieldGroup>
  )
}

function PasswordSignIn() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    const { error: signInErr } = await signIn.email(
      { email, password },
      { onError: () => {} },
    )
    if (signInErr) {
      // Sign-in failed — try auto sign-up
      const { error: signUpErr } = await signUp.email(
        { name: email.split("@")[0], email, password },
        { onError: () => {} },
      )
      if (signUpErr) {
        setError(signInErr.message ?? "Invalid email or password")
        setLoading(false)
        return
      }
    }
    window.location.href = "/workspaces?auto"
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-bold">Welcome back</h1>
          <p className="text-balance text-muted-foreground">
            Sign in or create an account to get started
          </p>
        </div>
        {error && <FieldError>{error}</FieldError>}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Field>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </Field>
        <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
          Or continue with
        </FieldSeparator>
        <Field className="grid grid-cols-2 gap-4">
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              signIn.social({ provider: "github", callbackURL: "/workspaces?auto" })
            }
          >
            <SiGithub className="size-4" />
            GitHub
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              signIn.social({ provider: "google", callbackURL: "/workspaces?auto" })
            }
          >
            <SiGoogle className="size-4" />
            Google
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

export default function SignInPage() {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <GradientBackground />
      <div className="w-full max-w-sm md:max-w-4xl">
        <div className="flex flex-col gap-6">
          <Card className="overflow-hidden p-0">
            <CardContent className="grid p-0 md:grid-cols-2">
              <div className="p-6 md:p-8">
                {isProd ? <OTPSignIn /> : <PasswordSignIn />}
              </div>
              <div className="hidden bg-muted md:flex items-center justify-center overflow-clip min-h-[320px]">
                <TypewriterVisual className="scale-[0.55] shrink-0" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
