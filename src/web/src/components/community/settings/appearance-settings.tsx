"use client"

import { useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Sun, Moon, Monitor } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Field } from "./field"
import styles from "./appearance-settings.module.css"

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useAtom(useCreateAtom(false))
  useEffect(() => setMounted(true), [setMounted])
  const active = mounted ? theme ?? "system" : undefined

  return <Field label="Theme">
    <div className={styles.switch}>
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => <Button key={value}
        variant={active === value ? "secondary" : "ghost"}
        onClick={() => setTheme(value)} aria-pressed={active === value}>
        <Icon aria-hidden="true" className="size-4" />{label}
      </Button>)}
    </div>
  </Field>
}
