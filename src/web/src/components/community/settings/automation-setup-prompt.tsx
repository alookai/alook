"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const setupPrompt = "Read https://alook.ai/agent.md and help me configure Alook Automation. Ask what I want to automate, guide me through choosing access-code permissions and limits, then help me configure the code locally and run the right CLI commands."

export function AutomationSetupPrompt() {
  const [copyState, setCopyState] = useAtom(useCreateAtom<"idle" | "copied" | "error">("idle"))
  return <div className="space-y-3 border-t border-border pt-6" data-testid="automation-setup-prompt">
    <p className="text-xs leading-5 text-muted-foreground">Copy this prompt and paste it into any agent to set up Automation.</p>
    <div className="relative">
      <Input aria-label="Automation setup prompt" readOnly value={setupPrompt} className="h-11 truncate pr-12 text-sm" />
      <Button type="button" variant="ghost" size="icon" aria-label="Copy prompt" title={copyState === "copied" ? "Prompt copied" : "Copy prompt"} className="absolute top-0 right-0 size-11 rounded-l-none" onClick={async () => {
        try { await navigator.clipboard.writeText(setupPrompt); setCopyState("copied") }
        catch { setCopyState("error") }
      }}>{copyState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
    </div>
    <span role="status" className={copyState === "error" ? "block text-xs leading-5 text-muted-foreground" : "sr-only"}>{copyState === "copied" ? "Prompt copied" : copyState === "error" ? "Copy failed. Select the prompt and copy it manually." : ""}</span>
  </div>
}
