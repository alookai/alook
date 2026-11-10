import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { delay, http, HttpResponse } from "msw"
import SignInPageClient from "@/app/(auth)/sign-in/sign-in-client"
import { SignInEmailField, SignInOtpField } from "@/app/(auth)/sign-in/sign-in-fields"

function Fields({ error = false, loading = false }: { error?: boolean; loading?: boolean }) { const [email, setEmail] = useState(""); const [code, setCode] = useState(""); return <div className="mx-auto flex max-w-sm flex-col gap-6 p-4"><SignInEmailField email={email} onChange={(event) => setEmail(event.target.value)} error={error ? "Enter a valid email address." : undefined} /><SignInOtpField code={code} onChange={setCode} autoFocus={false} loading={loading} error={error ? "This code has expired." : undefined} /></div> }
const meta = { title: "Web/Pages/Sign in", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Actual sign-in UI. Anonymous session is local; unprovided authentication commands produce explicit fixture errors. This does not sign in to a real account or verify OAuth." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Page: Story = {
  render: () => <SignInPageClient isProd={false} appleEnabled />,
  beforeEach({ msw }) {
    msw.use(http.post("*/api/auth/sign-in/social", async () => {
      await delay(8000)
      return HttpResponse.json({ code: "SOCIAL_START_UNAVAILABLE", message: "Local preview sign-in failure." }, { status: 503 })
    }))
  },
  parameters: { docs: { description: { story: "Each provider waits eight seconds, then returns a local failure. Inspect selected-button progress and retry recovery; this never starts external OAuth." } } },
}
export const EmailAndCode: Story = { render: () => <Fields /> }
export const Invalid: Story = { render: () => <Fields error /> }
export const Loading: Story = { render: () => <Fields loading /> }
