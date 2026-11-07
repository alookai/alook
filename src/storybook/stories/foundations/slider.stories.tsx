import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Slider, SliderControl, SliderTrack, SliderRange, SliderThumb } from "@/components/ui/slider"

function VolumeSlider({ disabled = false, onValueChange }: { disabled?: boolean; onValueChange?: (value: number) => void }) { return <Slider defaultValue={40} disabled={disabled} onValueChange={onValueChange}><SliderControl><SliderTrack><SliderRange /></SliderTrack><SliderThumb aria-label="Volume" /></SliderControl></Slider> }
const meta = { title: "Web/Foundations/Slider", component: VolumeSlider, tags: ["autodocs", "ai-generated"], args: { disabled: false, onValueChange: fn() } } satisfies Meta<typeof VolumeSlider>
export default meta
type Story = StoryObj<typeof meta>
export const Volume: Story = {}
export const Disabled: Story = { args: { disabled: true } }
