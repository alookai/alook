import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { StepSlide } from "@/components/ui/step-slide"
import { Button } from "@/components/ui/button"

function StepExample() { const [step, setStep] = useState(0); return <div className="max-w-md"><StepSlide step={String(step)} order={step}><div className="py-4"><h2 className="text-lg font-medium">{step === 0 ? "Choose a machine" : "Choose a model"}</h2><p className="my-4">{step === 0 ? "Connect a machine to continue." : "Select the model for this agent. This second step has more content so the original height animation is visible."}</p><Button onClick={() => setStep(step === 0 ? 1 : 0)}>{step === 0 ? "Next" : "Back"}</Button></div></StepSlide></div> }
const meta = { title: "Web/Foundations/Step motion", component: StepExample, tags: ["autodocs", "ai-generated"] } satisfies Meta<typeof StepExample>
export default meta
type Story = StoryObj<typeof meta>
export const ForwardAndBack: Story = {}
