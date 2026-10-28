"use client"

import type { MachineSummary } from "@/hooks/community/use-machines"
import { isPresenceOnline } from "@alook/shared"
import { Label } from "@/components/ui/label"
import { machineName } from "@/lib/community/machine-name"
import { cn } from "@/lib/utils"

export function BotMachineField({ machines, machineId, onChange, error, radioName = "bot-machine" }: {
  machines: MachineSummary[]
  machineId: string
  onChange: (id: string) => void
  error?: string
  radioName?: string
}) {
  return (
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Machine</Label>
            {machines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No paired machines — pair one first.
              </p>
            ) : (
              <div
                className="flex flex-col gap-2"
                role="radiogroup"
                aria-label="Machine"
                data-testid="bot-machine-picker"
              >
                {machines.map((m) => {
                  const online = isPresenceOnline(m.status)
                  const selected = machineId === m.id
                  return (
                    <label
                      key={m.id}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors",
                        selected ? "border-primary bg-primary/5" : "border-border/50 hover:border-foreground/20",
                        !online && "opacity-40 pointer-events-none",
                      )}
                    >
                      <input
                        type="radio"
                        name={radioName}
                        value={m.id}
                        checked={selected}
                        disabled={!online}
                        onChange={() => onChange(m.id)}
                        className="accent-primary size-3.5"
                      />
                      <span className="text-sm">{machineName(m)}</span>
                      <span
                        className={cn(
                          "ml-auto inline-flex items-center gap-1 text-xs",
                          online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block size-1.5 rounded-full",
                            online ? "bg-status-online" : "bg-muted-foreground",
                          )}
                        />
                        {online ? "Online" : "Offline"}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>
  )
}
