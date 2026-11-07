import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import ContactPage from "@/app/contact/page"
import HomePage from "@/app/(home)/page"
import DemoPage from "@/app/demo/page"
import PrivacyPage from "@/app/privacy/page"
import PrivacyLayout from "@/app/privacy/layout"
import TermsPage from "@/app/terms/page"
import TermsLayout from "@/app/terms/layout"
import { DownloadPageView } from "@/components/download/download-page"
import ErrorPage from "@/app/error"
import NotFoundPage from "@/app/not-found"

const meta = { title: "Web/Pages/Public pages", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Real public page compositions. Local preview data does not confirm external navigation, downloads or server operations." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Home: Story = { render: () => <HomePage /> }
export const CommunityDemo: Story = { loaders: [async () => ({ page: await DemoPage({ searchParams: Promise.resolve({}) }) })], render: (_, context) => context.loaded.page }
export const Contact: Story = { render: () => <ContactPage /> }
export const Privacy: Story = { render: () => <PrivacyLayout><PrivacyPage /></PrivacyLayout> }
export const Terms: Story = { render: () => <TermsLayout><TermsPage /></TermsLayout> }
export const DownloadsUnavailable: Story = { render: () => <DownloadPageView catalog={{ installers: [], unavailable: true }} /> }
export const Error: Story = { render: () => <div className="flex min-h-160"><ErrorPage error={new globalThis.Error("Local preview")} reset={fn()} /></div> }
export const NotFound: Story = { render: () => <div className="flex min-h-160"><NotFoundPage /></div> }
