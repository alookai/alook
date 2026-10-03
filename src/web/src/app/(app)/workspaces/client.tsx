"use client"

import { useMutation, useQuery, type Query } from "@tanstack/react-query"
import type { Workspace } from "@alook/shared"
import { applicationWorkspacesOptions } from "@/hooks/workspace/settings-query-options"
import { useApplicationViewSource } from "@/hooks/use-application-view-source"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { GradientBackground } from "@/components/gradient-background"
import { Logo } from "@/components/logo"
import { Plus, ArrowRight, LogOut, Loader2 } from "lucide-react"
import { useApplicationSignOut } from "@/hooks/use-application-sign-out"
import { useApplicationOwner } from "@/lib/application-owner";
import { assertApplicationOwner, captureApplicationOwner, invalidateApplicationAuthentication } from "@/lib/application-owner"
import { apiFetch, toastApiError } from "@/lib/api/client"

export function WorkspaceListClient({
  workspaces: initialWorkspaces,
}: {
  workspaces: Workspace[]
}) {
  const applicationOwner = useApplicationOwner();
  const logout = useApplicationSignOut();
  const router = useRouter()
  const source = useApplicationViewSource("workspace-list")
  const options = applicationWorkspacesOptions(applicationOwner)
  const resource = useQuery({ ...options, initialData: initialWorkspaces, initialDataUpdatedAt: 0 })
  const workspaces = resource.data
  type Intent = { original: ReturnType<typeof source.capture>; resource: Query | undefined }
  const command = useMutation({ mutationKey: [...options.queryKey, "create"], gcTime: 0,
    mutationFn: async ({ original, resource }: Intent) => {
      original.assert()
      const current = () => resource && applicationOwner.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true }) === resource
      if (current()) await applicationOwner.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })
      original.assert()
      const result = await apiFetch<Workspace>("/api/workspaces", {
        method: "POST", body: JSON.stringify({ name: "Personal", slug: "" }),
        authenticationAccount: applicationOwner.userId, signal: original.signal, assertActive: original.assert,
        onUnauthorized: () => { original.assert(); return invalidateApplicationAuthentication(original.token, original.signal) },
      })
      original.assert()
      if (current()) {
        await applicationOwner.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })
        original.assert()
        if (current()) applicationOwner.queryClient.setQueryData<Workspace[]>(options.queryKey, (rows) => rows ? [...rows.filter((row) => row.id !== result.id), result] : rows)
      }
      return result
    },
  })
  const creating = command.isPending
  const handleNewWorkspace = async () => {
    const original = source.capture()
    original.assert()
    if (applicationOwner.queryClient.getMutationCache().findAll({ mutationKey: [...options.queryKey, "create"], status: "pending" }).length) return
    try {
      const data = await command.mutateAsync({ original, resource: applicationOwner.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true }) })
      original.assert()
      router.push(`/studio/new?workspace_id=${data.id}`)
    } catch (error) { toastApiError(error, "Failed to create workspace", original.assert) }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center p-6">
      <GradientBackground />

      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-4 text-muted-foreground"
        onClick={async () => {
          const token = captureApplicationOwner(applicationOwner)
          try { if (await logout.mutateAsync()) router.push("/sign-in") }
          catch (error) { toastApiError(error, "Failed to log out", () => assertApplicationOwner(token)) }
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
              <CardContent className="flex items-center justify-between px-3 py-2">
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
          onClick={handleNewWorkspace}
          disabled={creating}
        >
          {creating ? (
            <><Loader2 className="size-4 animate-spin" /> Creating...</>
          ) : (
            <><Plus className="size-4" /> New workspace</>
          )}
        </Button>
      </div>
    </div>
  )
}
