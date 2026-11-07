import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { AttachmentCard } from "@/components/community/messages/attachment-card"
import { AttachmentPreviewSheet } from "@/components/community/messages/attachment-preview-sheet"
import { HtmlAttachmentPreview } from "@/components/community/messages/html-attachment-preview"
import { ImageLightbox } from "@/components/community/messages/image-lightbox"
import { CodePreview } from "@/components/community/messages/code-preview"
import { FileDownloadButton } from "@/components/file-download-button"
import { Button } from "@/components/ui/button"
import { Spoiler, MentionPill, ChannelPill, ServerPill } from "@/components/community/messages/inline-marks"
import { RedactedText } from "@/components/community/messages/redacted-text"
import type { FileAttachment } from "@/lib/community/models/message"

const pdf: FileAttachment = { id: "storybook-pdf", kind: "file", name: "example.pdf", url: "/preview/example.pdf", size: "1 KB", contentType: "application/pdf" }
const html = { id: "storybook-html", kind: "file" as const, name: "attachment.html", url: "/preview/attachment.html", size: "1 KB", contentType: "text/html" }
function PdfExample() { const [open, setOpen] = useState(false); return <><AttachmentCard attachment={pdf} onPreview={() => setOpen(true)} /><AttachmentPreviewSheet open={open} attachment={open ? pdf : null} onOpenChange={(next) => setOpen(next)} /></> }
function ImageExample() { const [open, setOpen] = useState(false); return <><Button onClick={() => setOpen(true)}>Open image</Button><ImageLightbox image={open ? { originalUrl: "/landing/people/lin.webp", name: "Profile artwork" } : null} onClose={() => setOpen(false)} /></> }
const meta = { title: "Web/Business/Attachments and rich content", tags: ["ai-generated"], decorators: [(Story) => <BusinessFixtures><Story /></BusinessFixtures>], parameters: { docs: { description: { component: "Actual attachment renderers with local PDF/HTML/code/audio files. Media playback, clipboard and OS download outcomes require their own actual checks." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Pdf: Story = { render: () => <PdfExample /> }
export const Html: Story = { render: () => <HtmlAttachmentPreview attachment={html} /> }
export const Code: Story = { render: () => <CodePreview language="typescript" content={'export const channel = { name: "general", kind: "text" }'} /> }
export const Audio: Story = { render: () => <AttachmentCard attachment={{ id: "storybook-audio", kind: "file", name: "tone.wav", url: "/preview/tone.wav", size: "16 KB", contentType: "audio/wav" }} /> }
export const UnavailableVideo: Story = { render: () => <AttachmentCard attachment={{ id: "storybook-video", kind: "file", name: "unavailable.mp4", url: "/preview/unavailable.mp4", size: "0 KB", contentType: "video/mp4" }} /> }
export const Image: Story = { render: () => <ImageExample /> }
export const Download: Story = { render: () => <FileDownloadButton url="/preview/example.txt" filename="example.ts">Download local example</FileDownloadButton> }
export const InlineContent: Story = { render: () => <div className="flex flex-wrap items-center gap-3"><Spoiler>Hidden until opened</Spoiler><MentionPill onClick={fn()}>Alli</MentionPill><ChannelPill onClick={fn()}>general</ChannelPill><ServerPill onClick={fn()}>Studio</ServerPill><RedactedText text="Contact: [REDACTED]" /></div> }
