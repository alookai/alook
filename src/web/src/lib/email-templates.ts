export type OtpType =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email"
  | "account-deletion"

const subjectByType: Record<OtpType, string> = {
  "sign-in": "Your Alook sign-in code",
  "email-verification": "Verify your Alook email",
  "forget-password": "Reset your Alook password",
  "change-email": "Confirm your new email address",
  "account-deletion": "Your Alook account deletion code",
}

const headingByType: Record<OtpType, string> = {
  "sign-in": "Sign in to Alook",
  "email-verification": "Verify your email",
  "forget-password": "Reset your password",
  "change-email": "Confirm email change",
  "account-deletion": "Delete your Alook account",
}

const descriptionByType: Record<OtpType, string> = {
  "sign-in": "Enter this code to sign in to your account.",
  "email-verification": "Enter this code to verify your email address.",
  "forget-password": "Enter this code to reset your password.",
  "change-email": "Enter this code to confirm your new email address.",
  "account-deletion": "Enter this code in User Settings to permanently delete your account.",
}

export function getOtpSubject(type: OtpType): string {
  return subjectByType[type]
}

export function renderOtpEmail(otp: string, type: OtpType): string {
  const heading = headingByType[type]
  const description = descriptionByType[type]

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f3f0;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background-color:#ffffff;border-radius:8px;padding:40px 36px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
<tr><td>
  <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#8c7e6f;letter-spacing:0.04em;text-transform:uppercase;">Alook</p>
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#2c2825;line-height:1.3;">${heading}</h1>
  <p style="margin:0 0 28px;font-size:15px;color:#6b6057;line-height:1.5;">${description}</p>
  <div style="background-color:#faf8f6;border:1px solid #ebe7e2;border-radius:6px;padding:20px;text-align:center;margin:0 0 28px;">
    <span style="font-size:32px;font-weight:700;letter-spacing:0.2em;color:#2c2825;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,Courier,monospace;">${otp}</span>
  </div>
  <p style="margin:0;font-size:13px;color:#9b9189;line-height:1.5;">This code expires in 5 minutes. If you didn't request this, you can safely ignore this email.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}
