"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type MessageNotificationData = {
  closeLabel?: string
  icon?: React.ReactNode
  testId?: string
}

const messageNotification = ToastPrimitive.createToastManager<MessageNotificationData>()

function ToastProvider(props: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal(props: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="message-notification-portal" {...props} />
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      aria-label="Notifications"
      data-slot="message-notification-viewport"
      className={cn(
        "pointer-events-none fixed inset-x-4 top-[calc(env(safe-area-inset-top)+1rem)] z-100 mx-auto w-auto max-w-lg outline-none sm:w-full",
        className,
      )}
      {...props}
    />
  )
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="message-notification"
      swipeDirection={["up", "left", "right"]}
      className={cn(
        "group/message-notification pointer-events-auto absolute top-0 left-0 z-[calc(1000-var(--toast-index))] w-full origin-top rounded-xl border border-border bg-popover text-popover-foreground shadow-(--e2) outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "[--gap:0.5rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.04)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_300ms_cubic-bezier(0.2,0.8,0.2,1),opacity_200ms,height_150ms] motion-reduce:transition-none",
        "after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-limited:opacity-0 data-starting-style:transform-[translateY(-150%)]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:transform-[translateY(-150%)]",
        "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        className,
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="message-notification-content"
      className={cn(
        "grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 overflow-hidden p-4 transition-opacity duration-200 ease-out data-behind:opacity-0 data-expanded:opacity-100 motion-reduce:transition-none sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center",
        className,
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="message-notification-title"
      className={cn("text-sm font-semibold leading-5", className)}
      {...props}
    />
  )
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="message-notification-description"
      className={cn("text-sm leading-5 text-muted-foreground", className)}
      {...props}
    />
  )
}

function ToastAction({
  className,
  render = <Button />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="message-notification-action"
      render={render}
      className={cn(
        "col-span-2 col-start-2 row-start-2 h-11 w-full shrink-0 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:h-8 sm:w-auto",
        className,
      )}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="message-notification-close"
      render={render}
      className={cn(
        "relative col-start-3 row-start-1 size-11 shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground sm:col-start-4 sm:size-7",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  )
}

function ToastIcon({ toastItem }: { toastItem: ToastPrimitive.Root.ToastObject<MessageNotificationData> }) {
  const customIcon = toastItem.data?.icon
  const statusIcon = toastItem.type === "success"
    ? <CircleCheckIcon />
    : toastItem.type === "info"
      ? <InfoIcon />
      : toastItem.type === "warning"
        ? <TriangleAlertIcon />
        : toastItem.type === "error"
          ? <OctagonXIcon />
          : toastItem.type === "loading"
            ? <Loader2Icon className="animate-spin motion-reduce:animate-none" />
            : null
  const icon = customIcon ?? statusIcon
  if (!icon) return null

  return (
    <span
      aria-hidden="true"
      data-slot="message-notification-icon"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5",
        toastItem.type === "warning"
          ? "bg-warning/15 text-warning"
          : toastItem.type === "error"
            ? "bg-destructive/10 text-destructive"
            : toastItem.type === "success"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
      )}
    >
      {icon}
    </span>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager<MessageNotificationData>()

  return toasts.map((toastItem) => {
    const hasIcon = Boolean(
      toastItem.data?.icon
      || ["success", "info", "warning", "error", "loading"].includes(toastItem.type ?? ""),
    )
    const closeLabel = toastItem.data?.closeLabel ?? "Close notification"

    return (
      <Toast
        key={toastItem.id}
        toast={toastItem}
        data-testid={toastItem.data?.testId}
      >
        <ToastContent
          className={hasIcon
            ? undefined
            : "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto]"}
        >
          <ToastIcon toastItem={toastItem} />
          <div className={cn(
            "row-start-1 flex min-w-0 flex-col gap-1",
            hasIcon ? "col-start-2" : "col-start-1",
          )}>
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastAction
            className={hasIcon
              ? undefined
              : "col-span-2 col-start-1 sm:col-span-1 sm:col-start-2"}
          />
          <ToastClose
            aria-label={closeLabel}
            title={closeLabel}
            className={hasIcon ? undefined : "col-start-2 sm:col-start-3"}
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">{closeLabel}</span>
          </ToastClose>
        </ToastContent>
      </Toast>
    )
  })
}

function MessageNotificationToaster({
  toastManager = messageNotification,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider toastManager={toastManager} limit={3} {...props}>
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

export {
  MessageNotificationToaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  messageNotification,
}
