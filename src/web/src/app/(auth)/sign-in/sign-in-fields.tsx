import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"

export function SignInEmailField({
  email,
  error,
  onChange,
}: {
  email: string
  error?: string
  onChange: React.ChangeEventHandler<HTMLInputElement>
}) {
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="email">Email</FieldLabel>
      <Input
        id="email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error ? "sign-in-email-error" : undefined}
        required
        autoFocus
      />
      {error && <FieldError id="sign-in-email-error">{error}</FieldError>}
    </Field>
  )
}

export function SignInOtpField({
  code,
  error,
  loading,
  onChange,
}: {
  code: string
  error?: string
  loading: boolean
  onChange: (value: string) => void
}) {
  return (
    <Field data-invalid={!!error}>
      <div
        data-slot="sign-in-otp-field"
        className="mx-auto flex w-fit! flex-col items-center gap-2"
      >
        <InputOTP
          maxLength={6}
          value={code}
          onChange={onChange}
          disabled={loading}
          aria-label="Verification code"
          aria-invalid={!!error}
          aria-describedby={error ? "sign-in-otp-error" : undefined}
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
        {error && (
          <FieldError id="sign-in-otp-error" className="w-full text-center">
            {error}
          </FieldError>
        )}
      </div>
    </Field>
  )
}
