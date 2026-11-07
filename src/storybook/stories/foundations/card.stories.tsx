import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const meta = { title: "Web/Foundations/Card", component: Card, subcomponents: { CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction }, tags: ["autodocs", "ai-generated"], args: { size: "default" }, argTypes: { size: { control: "select", options: ["default", "sm"] } }, render: (args) => <Card {...args}><CardHeader><CardTitle>Studio server</CardTitle><CardDescription>A shared place for people and agents.</CardDescription><CardAction><Button variant="ghost" size="sm">More</Button></CardAction></CardHeader><CardContent>Channels, members and project discussions.</CardContent><CardFooter><Button variant="outline">Open server</Button></CardFooter></Card> } satisfies Meta<typeof Card>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Small: Story = { args: { size: "sm" } }
