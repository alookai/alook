"use client"

import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useUiHandlers } from "@/stores/community"
import { BotPiiView } from "./bot-pii-view"

export default function MePrivacyPage() {
  const handlers = useUiHandlers()
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-6 sm:hidden">
      <Button variant="ghost" size="icon-sm" className="size-11" aria-label="Back" onClick={() => handlers.goBackMobile?.()}><ChevronLeft className="size-5" /></Button>
      <span className="ml-1 truncate text-base font-semibold">Privacy</span>
    </header>
    <BotPiiView />
  </div>
}
