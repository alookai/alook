"use client"

import { Suspense, useEffect, useState, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { authClient, useSession } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { GradientBackground } from "@/components/gradient-background"

type Step = "loading" | "code" | "approve" | "done" | "denied"

export default function DeviceAuthPage() {
  return (
    <Suspense>
      <DeviceAuthPageInner />
    </Suspense>
  )
}

function DeviceAuthPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { data: session, isPending } = useSession()

  const urlCode = searchParams.get("user_code") || ""
  const [userCode, setUserCode] = useState(urlCode)
  const [step, setStep] = useState<Step>(urlCode ? "loading" : "code")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const autoVerified = useRef(false)

  useEffect(() => {
    if (!isPending && !session) {
      const callbackUrl = `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`
      router.push(`/sign-in?redirect=${encodeURIComponent(callbackUrl)}`)
    }
  }, [isPending, session, router, userCode])

  useEffect(() => {
    if (!urlCode || !session || autoVerified.current) return
    autoVerified.current = true

    async function autoVerify() {
      try {
        const res = await authClient.device({ query: { user_code: urlCode.trim() } })
        if (res.error) {
          setError(res.error.error_description || "Invalid or expired code")
          setStep("code")
        } else {
          setStep("approve")
        }
      } catch {
        setError("Failed to verify code")
        setStep("code")
      }
    }

    autoVerify()
  }, [urlCode, session])

  useEffect(() => {
    if (step === "done") {
      const timer = setTimeout(() => {
        router.push("/workspaces?auto")
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [step, router])

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res = await authClient.device({ query: { user_code: userCode.trim() } })
      if (res.error) {
        setError(res.error.error_description || "Invalid or expired code")
      } else {
        setStep("approve")
      }
    } catch {
      setError("Failed to verify code")
    }
    setLoading(false)
  }

  async function handleApprove() {
    setError("")
    setLoading(true)
    try {
      const res = await authClient.device.approve({ userCode: userCode.trim() })
      if (res.error) {
        setError(res.error.error_description || "Failed to approve")
      } else {
        setStep("done")
      }
    } catch {
      setError("Failed to approve device")
    }
    setLoading(false)
  }

  async function handleDeny() {
    setError("")
    setLoading(true)
    try {
      await authClient.device.deny({ userCode: userCode.trim() })
      setStep("denied")
    } catch {
      setError("Failed to deny device")
    }
    setLoading(false)
  }

  if (isPending || !session) {
    return null
  }

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <GradientBackground />
      <div className="w-full max-w-sm">
        <Card>
          <CardContent className="p-6">
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-2xl font-bold">Authorize Device</h1>
                {step === "loading" && (
                  <p className="text-sm text-muted-foreground">
                    Verifying...
                  </p>
                )}
                {step === "code" && (
                  <p className="text-sm text-muted-foreground">
                    Enter the code shown on your terminal
                  </p>
                )}
                {step === "approve" && (
                  <p className="text-sm text-muted-foreground">
                    A device is requesting access to your account
                  </p>
                )}
              </div>

              {error && <FieldError>{error}</FieldError>}

              {step === "loading" && (
                <div className="flex justify-center py-4">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}

              {step === "code" && (
                <form onSubmit={handleVerifyCode}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="user_code">Device Code</FieldLabel>
                      <Input
                        id="user_code"
                        type="text"
                        placeholder="XXXX-XXXX"
                        value={userCode}
                        onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                        required
                        autoFocus
                        className="text-center text-lg tracking-widest font-mono"
                      />
                    </Field>
                    <Field>
                      <Button type="submit" disabled={loading || !userCode.trim()} className="w-full">
                        {loading ? "Verifying..." : "Verify Code"}
                      </Button>
                    </Field>
                  </FieldGroup>
                </form>
              )}

              {step === "approve" && (
                <FieldGroup>
                  <p className="text-sm text-center text-muted-foreground">
                    Code: <strong className="font-mono">{userCode}</strong>
                  </p>
                  <Field className="grid grid-cols-2 gap-4">
                    <Button variant="outline" onClick={handleDeny} disabled={loading}>
                      Deny
                    </Button>
                    <Button onClick={handleApprove} disabled={loading}>
                      {loading ? "Approving..." : "Approve"}
                    </Button>
                  </Field>
                </FieldGroup>
              )}

              {step === "done" && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Device authorized successfully. Redirecting...
                  </p>
                </div>
              )}

              {step === "denied" && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Device access denied. You can close this window.
                  </p>
                </div>
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
