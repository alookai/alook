import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Calendar } from "@/components/ui/calendar"

function InteractiveCalendar() {
  const [selected, setSelected] = useState<Date | undefined>(new Date(2026, 10, 25))
  return (
    <div className="w-fit rounded-xl border border-border bg-card p-2 shadow-(--e1)">
      <Calendar
        mode="single"
        weekStartsOn={1}
        selected={selected}
        onSelect={setSelected}
      />
    </div>
  )
}

const meta = {
  title: "Web/Foundations/Calendar",
  component: InteractiveCalendar,
  tags: ["autodocs", "ai-generated"],
} satisfies Meta<typeof InteractiveCalendar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
