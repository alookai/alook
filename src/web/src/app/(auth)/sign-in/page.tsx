"use client"

import { useState } from "react"
import { signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { SiGithub, SiGoogle } from "@icons-pack/react-simple-icons"

export default function SignInPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    const { error } = await signIn.email(
      { email, password },
      { onError: (ctx) => setError(ctx.error.message) },
    )
    if (error) {
      setError(error.message ?? "")
    } else {
      window.location.href = "/home"
      return
    }
    setLoading(false)
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-4xl">
        <div className="flex flex-col gap-6">
          <Card className="overflow-hidden p-0">
            <CardContent className="grid p-0 md:grid-cols-2">
              <form className="p-6 md:p-8" onSubmit={handleSubmit}>
                <FieldGroup>
                  <div className="flex flex-col items-center gap-2 text-center">
                    <h1 className="text-2xl font-bold">Welcome back</h1>
                    <p className="text-balance text-muted-foreground">
                      Sign in to your Alook account
                    </p>
                  </div>
                  {error && (
                    <FieldError>{error}</FieldError>
                  )}
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
                        signIn.social({ provider: "github", callbackURL: "/home" })
                      }
                    >
                      <SiGithub className="size-4" />
                      GitHub
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() =>
                        signIn.social({ provider: "google", callbackURL: "/home" })
                      }
                    >
                      <SiGoogle className="size-4" />
                      Google
                    </Button>
                  </Field>
                  <FieldDescription className="text-center">
                    Don&apos;t have an account?{" "}
                    <a href="/sign-up">Sign up</a>
                  </FieldDescription>
                </FieldGroup>
              </form>
              <div className="relative hidden bg-muted md:block">
                <img
                  src="/placeholder.svg"
                  alt="Alook"
                  className="absolute inset-0 h-full w-full object-cover dark:brightness-[0.2] dark:grayscale"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
