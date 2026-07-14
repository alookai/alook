"use client"

import { Lock } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  PRIVATE_CATEGORY_LABEL,
  PRIVATE_CATEGORY_DESC_PRIVATE,
  PRIVATE_CATEGORY_DESC_PUBLIC,
  PRIVATE_CATEGORY_LOCKED_SUFFIX,
} from "@/lib/community/category-copy"

export function PrivateCategoryRow({ isPrivate, onToggle, locked }: {
  isPrivate: boolean
  onToggle?: (v: boolean) => void
  locked?: boolean
}) {
  const description = isPrivate
    ? locked
      ? `${PRIVATE_CATEGORY_DESC_PRIVATE} ${PRIVATE_CATEGORY_LOCKED_SUFFIX}`
      : PRIVATE_CATEGORY_DESC_PRIVATE
    : PRIVATE_CATEGORY_DESC_PUBLIC
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2">
      <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{PRIVATE_CATEGORY_LABEL}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {onToggle && <Switch checked={isPrivate} onCheckedChange={onToggle} className="mt-0.5" />}
    </div>
  )
}
