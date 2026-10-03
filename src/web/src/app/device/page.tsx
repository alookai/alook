"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { Suspense, useEffect } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { PublicQueryProvider, applicationKey, captureApplicationOwner, assertApplicationOwner } from "@/lib/application-owner"
import { useApplicationViewSource } from "@/hooks/use-application-view-source"
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
      <PublicQueryProvider><DeviceAuthPageInner /></PublicQueryProvider>
    </Suspense>
  )
}

function DeviceAuthPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { data: session, isPending } = useSession()

  const urlCode = searchParams.get("user_code") || ""
  const [userCode, setUserCode] = useAtom(useCreateAtom(urlCode))
  const [verificationCode, setVerificationCode] = useAtom(useCreateAtom(urlCode.trim()))
  const source = useApplicationViewSource(`device:${verificationCode}`)
  const { owner } = source
  const verification = useQuery({
    queryKey: applicationKey(owner, "device-verification", verificationCode),
    enabled: !!verificationCode && !!session && !isPending, subscribed: !!verificationCode && !!session && !isPending, retry: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      const token = captureApplicationOwner(owner)
      assertApplicationOwner(token, signal)
      try {
        const res = await authClient.device({ query: { user_code: verificationCode }, fetchOptions: { signal } })
        assertApplicationOwner(token, signal)
        if (res.error) throw new Error(res.error.error_description || "Invalid or expired code")
        return true
      } catch (error) { assertApplicationOwner(token, signal); throw error }
    },
  })
  const command = useMutation({
    mutationKey: applicationKey(owner, "device-decision"),
    scope: { id: JSON.stringify(applicationKey(owner, "device-decision")) },
    mutationFn: async ({ kind, code, original }: { kind: "approve" | "deny"; code: string; original: ReturnType<typeof source.capture> }) => {
      original.assert()
      try {
        const options = { signal: original.signal, onRequest: () => original.assert(), onSuccess: () => original.assert(), onError: () => original.assert() }
        const res = kind === "approve" ? await authClient.device.approve({ userCode: code, fetchOptions: options }) : await authClient.device.deny({ userCode: code, fetchOptions: options })
        original.assert()
        if (res.error) throw new Error(res.error.error_description || `Failed to ${kind} device`)
        return kind
      } catch (error) { original.assert(); throw error }
    },
  })
  const currentDecision = command.variables?.code === verificationCode ? command : null
  const loading = verification.isFetching || !!currentDecision?.isPending
  const failure = currentDecision?.error ?? verification.error
  const error = failure instanceof DOMException && failure.name === "AbortError" ? "" : failure instanceof Error ? failure.message : ""
  const step: Step = currentDecision?.isSuccess ? currentDecision.data === "approve" ? "done" : "denied"
    : verification.isFetching ? "loading" : verification.isSuccess ? "approve" : "code"

  useEffect(() => {
    if (!isPending && !session) {
      const original = source.capture()
      original.assert()
      const callbackUrl = `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`
      router.push(`/sign-in?redirect=${encodeURIComponent(callbackUrl)}`)
    }
  }, [isPending, session, router, userCode, source])

  const handleVerifyCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = userCode.trim()
    command.reset()
    if (code === verificationCode) void verification.refetch({ cancelRefetch: false })
    else setVerificationCode(code)
  }
  const handleApprove = () => command.mutate({ kind: "approve", code: verificationCode, original: source.capture() })
  const handleDeny = () => command.mutate({ kind: "deny", code: verificationCode, original: source.capture() })

  if (isPending || !session) {
    return null
  }

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6 sm:p-10">
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
                  <p className="text-sm font-medium text-green-600">✓ Device authorized</p>
                  <p className="text-sm text-muted-foreground">
                    You can close this tab. The CLI will continue automatically.
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
