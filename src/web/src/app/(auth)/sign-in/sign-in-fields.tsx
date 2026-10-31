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
      <FieldLabel htmlFor="email" className="sr-only">
        Email
      </FieldLabel>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        className="h-11 px-4"
        value={email}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error ? "sign-in-email-error" : undefined}
        required
      />
      {error && <FieldError id="sign-in-email-error">{error}</FieldError>}
    </Field>
  )
}

export function SignInOtpField({
  code,
  error,
  loading,
  autoFocus = true,
  onChange,
}: {
  code: string
  error?: string
  loading: boolean
  autoFocus?: boolean
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
          autoFocus={autoFocus}
          className="text-base"
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} className="size-11 text-base sm:size-10" />
            <InputOTPSlot index={1} className="size-11 text-base sm:size-10" />
            <InputOTPSlot index={2} className="size-11 text-base sm:size-10" />
            <InputOTPSlot index={3} className="size-11 text-base sm:size-10" />
            <InputOTPSlot index={4} className="size-11 text-base sm:size-10" />
            <InputOTPSlot index={5} className="size-11 text-base sm:size-10" />
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
