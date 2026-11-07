import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"

const meta = { title: "Web/Foundations/Resizable panels", component: ResizablePanelGroup, subcomponents: { ResizablePanel, ResizableHandle }, tags: ["autodocs", "ai-generated"], args: { orientation: "horizontal" }, argTypes: { orientation: { control: "select", options: ["horizontal", "vertical"] } }, render: (args) => <div style={{ height: 320 }}><ResizablePanelGroup {...args}><ResizablePanel defaultSize="35%" minSize="15%"><div className="p-4">Channel list</div></ResizablePanel><ResizableHandle withHandle /><ResizablePanel minSize="20%"><div className="p-4">Conversation</div></ResizablePanel></ResizablePanelGroup></div> } satisfies Meta<typeof ResizablePanelGroup>
export default meta
type Story = StoryObj<typeof meta>
export const Horizontal: Story = {}
export const Vertical: Story = { args: { orientation: "vertical" } }
