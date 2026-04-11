"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { Plus, ArrowRight, Loader2 } from "lucide-react"

interface WorkspaceItem {
  id: string
  name: string
  slug: string
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
}

export function WorkspaceListClient({
  workspaces,
}: {
  workspaces: WorkspaceItem[]
}) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")

  const slug = deriveSlug(name)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !slug) return

    setError("")
    setCreating(true)
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error || "Failed to create workspace")
        return
      }
      const ws = (await res.json()) as WorkspaceItem
      router.push(`/w/${ws.slug}/home`)
    } catch {
      setError("Failed to create workspace")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center p-6">
      <GradientBackground />

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
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{ws.name}</p>
                  <p className="text-xs text-muted-foreground">{ws.slug}</p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          ))}
        </div>

        {showForm ? (
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-2">
              <Input
                placeholder="Workspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
              {slug && (
                <p className="text-xs text-muted-foreground pl-1">
                  Slug: {slug}
                </p>
              )}
            </div>
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowForm(false)
                  setName("")
                  setError("")
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={creating || !name.trim() || !slug}
                className="flex-1"
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Create"
                )}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setShowForm(true)}
          >
            <Plus className="size-4" />
            New workspace
          </Button>
        )}
      </div>
    </div>
  )
}
