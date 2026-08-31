"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@/lib/utils"
import { ChevronRightIcon, CheckIcon } from "lucide-react"
import { useAuthenticatedContextMenuPolicy } from "@/components/authenticated-context-menu-boundary"

type NativeContextGesture = {
  token: number
  source: EventTarget
  pointerId: number | null
  pointerType: string
  button: number
  ctrlKey: boolean
  startedAt: number
  clientX: number
  clientY: number
}

type NativeContextGestureController = {
  current(): NativeContextGesture | null
  arm(event: React.PointerEvent<HTMLElement>): void
  clear(token: number): void
}

const NativeContextGestureContext = React.createContext<NativeContextGestureController | null>(null)

function contextPointerId(event: MouseEvent): number | null {
  return "pointerId" in event && typeof event.pointerId === "number"
    ? event.pointerId
    : null
}

export function isSecondaryContextPointer({ button, ctrlKey }: Pick<MouseEvent, "button" | "ctrlKey">) {
  return button === 2 || (button === 0 && ctrlKey)
}

export function isKeyboardContextMenu({ key, shiftKey }: Pick<KeyboardEvent, "key" | "shiftKey">) {
  return key === "ContextMenu" || (key === "F10" && shiftKey)
}

export function nativeContextGestureMatches(
  gesture: NativeContextGesture,
  event: MouseEvent,
  source: EventTarget,
): boolean {
  if (gesture.source !== source || !isSecondaryContextPointer(event)) return false
  const pointerId = contextPointerId(event)
  return gesture.pointerId === null || pointerId === null || gesture.pointerId === pointerId
}

function ContextMenu({ disabled, ...props }: ContextMenuPrimitive.Root.Props) {
  const policy = useAuthenticatedContextMenuPolicy()
  const nextTokenRef = React.useRef(0)
  const gestureRef = React.useRef<NativeContextGesture | null>(null)
  const [gesture, setGesture] = React.useState<NativeContextGesture | null>(null)

  const clear = React.useCallback((token: number) => {
    if (gestureRef.current?.token !== token) return
    gestureRef.current = null
    setGesture((current) => current?.token === token ? null : current)
  }, [])

  const arm = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (disabled || !policy || !isSecondaryContextPointer(event.nativeEvent)) return
    if (policy.disposition(event.nativeEvent) !== "native") return
    const nativeEvent = event.nativeEvent
    const next: NativeContextGesture = {
      token: ++nextTokenRef.current,
      source: event.currentTarget,
      pointerId: contextPointerId(nativeEvent),
      pointerType: nativeEvent.pointerType,
      button: nativeEvent.button,
      ctrlKey: nativeEvent.ctrlKey,
      startedAt: nativeEvent.timeStamp,
      clientX: nativeEvent.clientX,
      clientY: nativeEvent.clientY,
    }
    gestureRef.current = next
    setGesture(next)
  }, [disabled, policy])

  React.useEffect(() => {
    if (!gesture) return
    const { token, pointerId } = gesture
    const clearMatchingPointer = (event: PointerEvent) => {
      if (pointerId === null || pointerId === event.pointerId) clear(token)
    }
    const clearOnBlur = () => clear(token)
    window.addEventListener("pointerup", clearMatchingPointer, true)
    window.addEventListener("pointercancel", clearMatchingPointer, true)
    window.addEventListener("blur", clearOnBlur)
    return () => {
      window.removeEventListener("pointerup", clearMatchingPointer, true)
      window.removeEventListener("pointercancel", clearMatchingPointer, true)
      window.removeEventListener("blur", clearOnBlur)
    }
  }, [clear, gesture])

  React.useEffect(() => () => {
    gestureRef.current = null
  }, [])

  const controller = React.useMemo<NativeContextGestureController>(() => ({
    current: () => gestureRef.current,
    arm,
    clear,
  }), [arm, clear])

  return (
    <NativeContextGestureContext.Provider value={controller}>
      <ContextMenuPrimitive.Root
        data-slot="context-menu"
        disabled={disabled || gesture !== null}
        {...props}
      />
    </NativeContextGestureContext.Provider>
  )
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return (
    <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
  )
}

function ContextMenuTrigger({
  className,
  onPointerDownCapture,
  onPointerLeave,
  onContextMenu,
  onKeyDown,
  ...props
}: ContextMenuPrimitive.Trigger.Props) {
  const policy = useAuthenticatedContextMenuPolicy()
  const gestureController = React.useContext(NativeContextGestureContext)
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event)
        gestureController?.arm(event)
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        const gesture = gestureController?.current()
        if (gesture && gesture.source === event.currentTarget) {
          gestureController?.clear(gesture.token)
        }
      }}
      onContextMenu={(event) => {
        onContextMenu?.(event)
        const gesture = gestureController?.current()
        if (!gesture) return
        const matches = nativeContextGestureMatches(
          gesture,
          event.nativeEvent,
          event.currentTarget,
        ) && policy?.disposition(event.nativeEvent) === "native"
        if (matches) event.preventBaseUIHandler()
        gestureController?.clear(gesture.token)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || !isKeyboardContextMenu(event.nativeEvent)) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }))
      }}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  align = "start",
  alignOffset = 4,
  side = "right",
  sideOffset = 0,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn("z-50 max-h-(--available-height) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95", className )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-2 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return (
    <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubContent({
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      data-slot="context-menu-sub-content"
      className="shadow-lg"
      side="right"
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon
          />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({
  ...props
}: ContextMenuPrimitive.RadioGroup.Props) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: ContextMenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon
          />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/context-menu-item:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
