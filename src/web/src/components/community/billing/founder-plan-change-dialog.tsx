"use client"

import type { BillingSummary } from "@alook/shared"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export function FounderPlanChangeDialog({ offer, busy, onCancel, onConfirm }: {
  offer: BillingSummary["offers"][number] | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return <Dialog open={offer !== null} onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
    <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>Leave Founder for {offer?.plan.displayName}?</DialogTitle>
        <DialogDescription>Completing this purchase permanently ends your Founder access. You can’t restore it, even if you later cancel your subscription. If you leave checkout without paying, you keep Founder.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>Keep Founder</Button>
        <Button disabled={busy} onClick={onConfirm}>{busy ? "Opening…" : "Continue to checkout"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
