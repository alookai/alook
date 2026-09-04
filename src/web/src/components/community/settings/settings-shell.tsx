"use client"

import type { LucideIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useBreakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import {
  SETTINGS_NAV_CLASS,
  SETTINGS_NAV_FOOTER_CLASS,
  SETTINGS_NAV_LABEL_CLASS,
  SETTINGS_TAB_CLASS,
  SETTINGS_TABS_LIST_CLASS,
} from "./settings-navigation"

export type SettingsShellTab<Value extends string> = {
  value: Value
  label: string
  icon: LucideIcon
}

export function SettingsShellPanel(
  props: Omit<ComponentProps<typeof TabsContent>, "keepMounted">,
) {
  return <TabsContent {...props} keepMounted />
}

export function SettingsShell<Value extends string>({
  value,
  onValueChange,
  label,
  title,
  tabs,
  onClose,
  navFooter,
  children,
}: {
  value: Value
  onValueChange: (value: Value) => void
  label: string
  title: ReactNode
  tabs: SettingsShellTab<Value>[]
  onClose: () => void
  navFooter?: ReactNode
  children: ReactNode
}) {
  const breakpoint = useBreakpoint()

  return (
    <Tabs
      orientation={breakpoint === "mobile" ? "horizontal" : "vertical"}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
      className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[4rem_auto_minmax(0,1fr)] gap-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:grid-rows-[4rem_minmax(0,1fr)]"
      data-testid={tid.settingsShell}
    >
      <header className="col-start-1 row-start-1 flex h-16 min-w-0 items-center px-4 sm:col-start-2 sm:px-8">
        <h1 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">{title}</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11 sm:size-8"
          onClick={onClose}
          aria-label="Close settings"
          data-testid={tid.settingsClose}
        >
          <X className="size-4" />
        </Button>
      </header>

      <nav
        className={SETTINGS_NAV_CLASS}
        style={{ background: "var(--d-rail)" }}
        data-testid={tid.settingsNav}
      >
        <div className={SETTINGS_NAV_LABEL_CLASS} data-testid={tid.settingsLabel}>{label}</div>
        <TabsList variant="line" className={SETTINGS_TABS_LIST_CLASS}>
          {tabs.map(({ value: tabValue, label: tabLabel, icon: Icon }) => (
            <TabsTrigger
              key={tabValue}
              value={tabValue}
              className={SETTINGS_TAB_CLASS}
              data-testid={tid.settingsTab(tabValue)}
            >
              <Icon className="size-4" />
              <span className="sr-only sm:not-sr-only">{tabLabel}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {navFooter ? (
          <div className={SETTINGS_NAV_FOOTER_CLASS}>{navFooter}</div>
        ) : null}
      </nav>

      <div
        className="col-start-1 row-start-3 min-h-0 min-w-0 overflow-y-auto bg-background px-4 pt-2 pb-4 thin-scrollbar sm:col-start-2 sm:row-start-2 sm:p-8 sm:pt-4"
        data-testid={tid.settingsContent}
      >
        {children}
      </div>
    </Tabs>
  )
}
