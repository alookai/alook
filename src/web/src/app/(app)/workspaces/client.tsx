"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { Plus, ArrowRight, LogOut } from "lucide-react"
import { signOut } from "@/lib/auth-client"

interface WorkspaceItem {
  id: string
  name: string
  slug: string
}

export function WorkspaceListClient({
  workspaces,
}: {
  workspaces: WorkspaceItem[]
}) {
  const router = useRouter()

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center p-6">
      <GradientBackground />

      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-4 text-muted-foreground"
        onClick={async () => {
          await signOut()
          router.push("/sign-in")
        }}
      >
        <LogOut className="size-4" />
        Log out
      </Button>

      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-3">
          <Logo size="lg" />
          <p className="text-sm text-muted-foreground">
            Choose a workspace to continue.
          </p>
        </div>

        <div className="space-y-3">
          {workspaces.map((ws) => (
            <Card
              key={ws.id}
              className="cursor-pointer transition-colors duration-200 hover:bg-accent/50"
              onClick={() => router.push(`/w/${ws.slug}/home`)}
            >
              <CardContent className="flex items-center justify-between px-3 py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium truncate">{ws.name}</p>
                  <p className="text-xs text-muted-foreground">{ws.slug}</p>
                </div>
                <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          ))}
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={() => router.push("/studio/new")}
        >
          <Plus className="size-4" />
          New workspace
        </Button>
      </div>
    </div>
  )
}
