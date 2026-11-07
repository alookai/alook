import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { ImageCropDialog } from "@/components/community/image-crop-dialog"
import { Button } from "@/components/ui/button"

function CropExample({ maskShape = "circle", onCropped }: { maskShape?: "circle" | "square"; onCropped: (file: File) => void }) { const [open, setOpen] = useState(false); const [result, setResult] = useState(""); return <><Button onClick={() => setOpen(true)}>Crop local image</Button>{result && <p className="mt-3 text-sm" role="status">{result}</p>}{open && <ImageCropDialog imageSrc="/landing/people/lin.webp" originalFileName="local-profile.webp" maskShape={maskShape} onCancel={() => setOpen(false)} onCropped={(file) => { setResult(`${file.name}: ${file.size} bytes created locally`); onCropped(file); setOpen(false) }} />}</> }
const meta = { title: "Web/Business/Image crop", component: CropExample, tags: ["autodocs", "ai-generated"], args: { maskShape: "circle", onCropped: fn() }, argTypes: { maskShape: { control: "select", options: ["circle", "square"] } }, parameters: { docs: { description: { component: "Original crop/zoom dialog with a local image. A produced File stays inside this example and its Action callback; no upload or system save is performed." } } } } satisfies Meta<typeof CropExample>
export default meta
type Story = StoryObj<typeof meta>
export const Avatar: Story = {}
export const ServerIcon: Story = { args: { maskShape: "square" } }
