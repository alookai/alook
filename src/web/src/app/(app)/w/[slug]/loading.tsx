import { Loader2 } from "lucide-react"
import { GradientBackground } from "@/components/gradient-background"

export default function WorkspaceLoading() {
  return (
    <div className="flex h-dvh items-center justify-center relative">
      <GradientBackground />
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}
