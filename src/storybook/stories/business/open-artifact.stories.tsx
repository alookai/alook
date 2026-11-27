import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { AccountFixtures } from "../../preview/business-fixtures"
import { Message } from "@/components/community/messages/message"
import { OpenArtifactCard } from "@/components/community/messages/open-artifact-card"
import { OpenArtifactSheet } from "@/components/community/messages/open-artifact-sheet"
import type { AlookPageEmbed } from "@/lib/community/open-artifact"

const docPage: AlookPageEmbed = {
  kind: "alook_page",
  id: "storybook-page-doc",
  type: "doc",
  title: "Q4 Architecture Brief",
}

const slidesPage: AlookPageEmbed = {
  kind: "alook_page",
  id: "storybook-page-slides",
  type: "slides",
  title: "Design System Review",
}

const revokedPage: AlookPageEmbed = {
  kind: "alook_page",
  id: "storybook-page-revoked",
  type: "doc",
  title: "Archived Release Notes",
}

function InteractivePageExample() {
  const [activePage, setActivePage] = useState<AlookPageEmbed | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <Message
        m={{
          id: "storybook-oa-msg",
          type: "chat",
          authorName: "Alli",
          content: "Drafted both the brief and the slide deck — click either card to open and edit side by side.",
          grouped: false,
          pages: [docPage, slidesPage],
        }}
        onCopy={fn()}
        onOpenPage={(page) => setActivePage(page)}
      />
      <OpenArtifactSheet
        page={activePage}
        open={activePage !== null}
        onOpenChange={(open) => { if (!open) setActivePage(null) }}
      />
    </div>
  )
}

function OpenSheetExample({ page }: { page: AlookPageEmbed }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex flex-col gap-3">
      <OpenArtifactCard page={page} onOpen={() => setOpen(true)} />
      <OpenArtifactSheet page={open ? page : null} open={open} onOpenChange={setOpen} />
    </div>
  )
}

const meta = {
  title: "Web/Business/Open Artifact",
  tags: ["ai-generated"],
  decorators: [(Story) => <AccountFixtures><Story /></AccountFixtures>],
  parameters: {
    docs: {
      description: {
        component: "Independent Open Artifact message card and resizable side/full-screen container. Live cross-origin Shell handshakes require the OA Worker host.",
      },
    },
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Cards: Story = {
  render: () => <InteractivePageExample />,
}

export const SideContainer: Story = {
  render: () => <OpenSheetExample page={docPage} />,
}

export const RevokedState: Story = {
  render: () => <OpenSheetExample page={revokedPage} />,
}
