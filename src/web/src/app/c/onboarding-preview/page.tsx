import { redirect } from "next/navigation"

export default function OnboardingPreviewPage() {
  redirect("/c/me/machines?onboarding-preview=1")
}
