"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getCalendarEvent } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  CalendarDays,
  CalendarOff,
  Loader2,
  Repeat as RepeatIcon,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  Agent,
  CalendarEvent,
  UpdateCalendarEventRequest,
} from "@alook/shared";
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea";
import { Kbd } from "@/components/ui/kbd";
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import { CalendarDatePicker } from "./calendar-date-picker";
import { CalendarTimePicker } from "./calendar-time-picker";
import {
  type RepeatUnit,
  parseRepeatInterval,
  formatRepeatInterval,
  unitLabel,
  isValidUnit,
  REPEAT_UNITS,
  PRESET_INTERVALS,
} from "./repeat-interval-utils";

interface CreateFormValues {
  agent_id: string;
  title: string;
  description?: string;
  scheduled_at: string;
  repeat_interval?: string;
  repeat_stop_date?: string;
}

export interface CalendarEventSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents?: Agent[];
  /** When provided, the sheet is in edit mode. */
  event?: CalendarEvent | null;
  /** When provided (without `event`), the sheet self-fetches the event data. */
  calendarEventId?: string | null;
  workspaceId?: string;
  /** When true, all fields render as non-editable display. */
  readonly?: boolean;
  defaultDate?: Date;
  defaultAgentId?: string;
  submitting?: boolean;
  saving?: boolean;
  deleting?: boolean;
  onCreate?: (values: CreateFormValues) => Promise<void> | void;
  onUpdate?: (
    event: CalendarEvent,
    patch: UpdateCalendarEventRequest
  ) => Promise<void>;
  onDelete?: (
    event: CalendarEvent,
    args?: { scope?: "this" | "following"; occurrence_at?: string }
  ) => void;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function nextSlotTime(d: Date, stepMin = 30): string {
  const total = d.getHours() * 60 + d.getMinutes();
  const next = Math.ceil((total + 1) / stepMin) * stepMin;
  const h = Math.floor(next / 60) % 24;
  const m = next % 60;
  return `${pad(h)}:${pad(m)}`;
}

function combineDateTime(date: Date, time: string): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  const h = match ? Number(match[1]) : date.getHours();
  const m = match ? Number(match[2]) : date.getMinutes();
  const out = new Date(date);
  out.setHours(h, m, 0, 0);
  return out;
}

function toYYYYMMDD(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizedDescription(value: string | null | undefined): string {
  return value?.trim() || "";
}

const GHOST_CONTROL =
  "h-7 border-0 bg-transparent px-2 text-sm text-foreground hover:bg-accent transition-colors -ml-2";


const TIME_INPUT =
  "h-7 w-12 border-0 bg-transparent px-1 text-sm tabular-nums text-foreground rounded-md outline-none focus-visible:ring-0";

interface PropertyRowProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function PropertyRow({ icon, children }: PropertyRowProps) {
  return (
    <div className="group flex items-center gap-2">
      <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

interface RecurringScopeDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (scope: "this" | "following") => void;
  loading?: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  loadingLabel: string;
  confirmVariant?: "default" | "destructive";
}

function RecurringScopeDialog({
  open,
  onOpenChange,
  onConfirm,
  loading,
  title,
  description,
  confirmLabel,
  loadingLabel,
  confirmVariant = "default",
}: RecurringScopeDialogProps) {
  const [scope, setScope] = useState<"this" | "following">("this");
  useEffect(() => {
    if (open) setScope("this");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-1">
          {(
            [
              { value: "this", label: "This event only" },
              { value: "following", label: "This and following events" },
            ] as const
          ).map((opt) => {
            const selected = scope === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setScope(opt.value)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "border-ring bg-accent/40"
                    : "border-border/60 hover:bg-accent/30"
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-4 items-center justify-center rounded-full border",
                    selected ? "border-foreground" : "border-border"
                  )}
                  aria-hidden
                >
                  {selected && <span className="size-2 rounded-full bg-foreground" />}
                </span>
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant={confirmVariant}
            onClick={() => onConfirm(scope)}
            disabled={loading}
          >
            {loading ? loadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DRAG_MIN_WIDTH = 320;
const DRAG_MAX_WIDTH_RATIO = 0.8;
const DRAG_DEFAULT_WIDTH = 500;

export function CalendarEventSheet({
  open,
  onOpenChange,
  agents = [],
  event,
  calendarEventId,
  workspaceId,
  readonly,
  defaultDate,
  defaultAgentId,
  submitting,
  saving,
  deleting,
  onCreate,
  onUpdate,
  onDelete,
}: CalendarEventSheetProps) {
  // --- Self-fetch logic ---
  const [fetchedEvent, setFetchedEvent] = useState<CalendarEvent | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; });

  useEffect(() => {
    if (!open || !calendarEventId || event) return;
    let cancelled = false;
    setFetchLoading(true);
    setFetchedEvent(null);
    getCalendarEvent(calendarEventId, workspaceId ?? "")
      .then((ev) => { if (!cancelled) setFetchedEvent(ev); })
      .catch(() => {
        if (cancelled) return;
        toast.error("Calendar event not found");
        onOpenChangeRef.current(false);
      })
      .finally(() => { if (!cancelled) setFetchLoading(false); });
    return () => { cancelled = true; };
  }, [open, calendarEventId, workspaceId, event]);

  const resolvedEvent = event ?? fetchedEvent;

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setTimeout(() => setFetchedEvent(null), 300);
    }
  };

  // --- Resizable drag handle ---
  const { width: sheetWidth, onPointerDown: onDragPointerDown, onPointerMove: onDragPointerMove, onPointerUp: onDragPointerUp } = useSheetResize({
    defaultWidth: DRAG_DEFAULT_WIDTH,
    minWidth: DRAG_MIN_WIDTH,
    maxWidthRatio: DRAG_MAX_WIDTH_RATIO,
  });

  const mode = resolvedEvent ? "edit" : "create";

  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dateValue, setDateValue] = useState<Date>(new Date());
  const [timeValue, setTimeValue] = useState<string>("09:00");
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatCount, setRepeatCount] = useState("1");
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>("day");

  const repeat = useMemo(() => {
    if (!repeatEnabled) return "";
    const n = parseInt(repeatCount, 10);
    if (!n || n < 1) return "";
    return formatRepeatInterval(n, repeatUnit);
  }, [repeatEnabled, repeatCount, repeatUnit]);
  const [stopDate, setStopDate] = useState<Date | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [deleteScopeOpen, setDeleteScopeOpen] = useState(false);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const focusDescription = () => {
    // TipTap renders its ProseMirror root as [contenteditable="true"] inside
    // the wrapper — there's no public ref, so query for it on demand.
    const node = descriptionRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    node?.focus();
  };

  useEffect(() => {
    if (!open) return;
    if (resolvedEvent) {
      const scheduled = new Date(resolvedEvent.scheduled_at);
      setAgentId(resolvedEvent.agent_id);
      setTitle(resolvedEvent.title);
      setDescription(resolvedEvent.description ?? "");
      setDateValue(scheduled);
      setTimeValue(parseTime(scheduled));
      const parsed = parseRepeatInterval(resolvedEvent.repeat_interval ?? "");
      if (parsed) {
        setRepeatEnabled(true);
        setRepeatCount(String(parsed.count));
        setRepeatUnit(parsed.unit);
      } else {
        setRepeatEnabled(false);
        setRepeatCount("1");
        setRepeatUnit("day");
      }
      setStopDate(
        resolvedEvent.repeat_stop_at ? new Date(resolvedEvent.repeat_stop_at) : null
      );
    } else {
      setAgentId(defaultAgentId || agents[0]?.id || "");
      setTitle("");
      setDescription("");
      setDateValue(defaultDate ?? new Date());
      setTimeValue(nextSlotTime(new Date()));
      setRepeatEnabled(false);
      setRepeatCount("1");
      setRepeatUnit("day");
      setStopDate(null);
    }
    // Seed only on open transition / event id change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resolvedEvent?.id]);

  const dirty = useMemo(() => {
    if (!resolvedEvent) return true;
    const scheduled = new Date(resolvedEvent.scheduled_at);
    return (
      title.trim() !== resolvedEvent.title ||
      normalizedDescription(description) !==
        normalizedDescription(resolvedEvent.description) ||
      agentId !== resolvedEvent.agent_id ||
      dateValue.getFullYear() !== scheduled.getFullYear() ||
      dateValue.getMonth() !== scheduled.getMonth() ||
      dateValue.getDate() !== scheduled.getDate() ||
      timeValue !== parseTime(scheduled) ||
      repeat !== (resolvedEvent.repeat_interval ?? "") ||
      (stopDate ? toYYYYMMDD(stopDate) : null) !==
        (resolvedEvent.repeat_stop_at ? toYYYYMMDD(new Date(resolvedEvent.repeat_stop_at)) : null)
    );
  }, [agentId, title, description, dateValue, timeValue, repeat, stopDate, resolvedEvent]);

  function validate(): string | null {
    if (!agentId) return "Select an agent";
    if (!title.trim()) return "Title is required";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeValue)) {
      return "Time must be HH:MM in 24-hour format";
    }
    if (repeatEnabled) {
      const n = parseInt(repeatCount, 10);
      if (!n || n < 1) return "Repeat count must be a positive number";
    }
    if (stopDate && !repeat) {
      return "Stop date requires a repeat interval";
    }
    const scheduled = combineDateTime(dateValue, timeValue);
    if (stopDate) {
      const stopEnd = new Date(stopDate);
      stopEnd.setHours(23, 59, 59, 999);
      if (stopEnd < scheduled) {
        return "Stop date must be on or after the first occurrence";
      }
    }
    return null;
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) return toast.error(err);
    const scheduled = combineDateTime(dateValue, timeValue);
    const desc = description?.trim() || undefined;
    await onCreate?.({
      agent_id: agentId,
      title: title.trim(),
      description: desc,
      scheduled_at: scheduled.toISOString(),
      repeat_interval: repeat || undefined,
      repeat_stop_date: stopDate ? toYYYYMMDD(stopDate) : undefined,
    });
  };

  function buildEditPatch(): UpdateCalendarEventRequest | null {
    if (!resolvedEvent) return null;
    const patch: UpdateCalendarEventRequest = {};
    const scheduled = combineDateTime(dateValue, timeValue);
    const scheduledIso = scheduled.toISOString();
    const nextTitle = title.trim();
    if (nextTitle !== resolvedEvent.title) patch.title = nextTitle;
    const nextDesc = normalizedDescription(description);
    const prevDesc = normalizedDescription(resolvedEvent.description);
    if (nextDesc !== prevDesc) patch.description = nextDesc === "" ? null : nextDesc;
    if (agentId !== resolvedEvent.agent_id) patch.agent_id = agentId;
    if (
      scheduledIso !== new Date(resolvedEvent.scheduled_at).toISOString()
    ) {
      patch.scheduled_at = scheduledIso;
    }
    const prevRepeat = resolvedEvent.repeat_interval ?? "";
    if (repeat !== prevRepeat) {
      patch.repeat_interval = repeat === "" ? null : repeat;
    }
    const nextStop = stopDate ? toYYYYMMDD(stopDate) : null;
    const prevStop = resolvedEvent.repeat_stop_at
      ? toYYYYMMDD(new Date(resolvedEvent.repeat_stop_at))
      : null;
    if (nextStop !== prevStop) {
      patch.repeat_stop_date = nextStop;
    }
    if (
      patch.title === undefined &&
      patch.description === undefined &&
      patch.agent_id === undefined &&
      patch.scheduled_at === undefined &&
      patch.repeat_interval === undefined &&
      patch.repeat_stop_date === undefined
    ) {
      return null;
    }
    return patch;
  }

  const commitEdit = async (patch: UpdateCalendarEventRequest) => {
    if (!resolvedEvent) return;
    await onUpdate?.(resolvedEvent, patch);
  };

  const handleEditSave = async () => {
    if (!resolvedEvent) return;
    const err = validate();
    if (err) return toast.error(err);
    const patch = buildEditPatch();
    if (!patch) return;
    if (resolvedEvent.repeat_interval) {
      setScopeOpen(true);
      return;
    }
    await commitEdit(patch);
  };

  const handleScopeConfirm = async (scope: "this" | "following") => {
    const patch = buildEditPatch();
    if (!patch) {
      setScopeOpen(false);
      return;
    }
    patch.scope = scope;
    if (scope === "this" && resolvedEvent?.occurrence_at) {
      patch.occurrence_at = resolvedEvent.occurrence_at;
    }
    await commitEdit(patch);
    setScopeOpen(false);
  };

  const handleDeleteClick = () => {
    if (!resolvedEvent) return;
    if (resolvedEvent.repeat_interval) {
      setDeleteScopeOpen(true);
      return;
    }
    onDelete?.(resolvedEvent);
  };

  const handleDeleteScopeConfirm = (scope: "this" | "following") => {
    if (!resolvedEvent) return;
    onDelete?.(resolvedEvent, {
      scope,
      occurrence_at: resolvedEvent.occurrence_at ?? undefined,
    });
    setDeleteScopeOpen(false);
  };

  // Shift+Enter submits from anywhere in the sheet — including inside the
  // description editor, where TipTap would otherwise insert a hard break.
  // Capture-phase so we beat the editor's keydown handler.
  const handleSubmitShortcut = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === "create") {
      formRef.current?.requestSubmit();
    } else {
      void handleEditSave();
    }
  };

  // Inline kbd hint rendered inside the submit button. Uses the button's own
  // foreground colour at reduced opacity so it reads on the primary fill in
  // both themes without needing a separate palette.
  const inlineSubmitHint = (
    <Kbd aria-hidden className="mr-1 hidden sm:inline-flex bg-background/20 text-inherit opacity-60">⇧ + ⏎</Kbd>
  );

  const a11yTitle = mode === "edit"
    ? title.trim() || "Untitled event"
    : title.trim() || "New calendar event";

  const titleInput = readonly ? (
    <p className="w-full px-0 py-1 font-news text-xl sm:text-2xl sm:text-3xl font-medium leading-[1.2] tracking-tight">
      {title || "Untitled event"}
    </p>
  ) : (
    <AutoResizeTextarea
      aria-label="Event title"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          focusDescription();
        }
      }}
      placeholder={mode === "edit" ? "Untitled event" : "New event"}
      autoFocus={mode === "create"}
      rows={1}
      className={cn(
        "w-full rounded-none border-0 bg-transparent px-0 py-1 font-news text-xl sm:text-2xl sm:text-3xl font-medium leading-[1.2] tracking-tight",
        "shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0",
        "placeholder:text-muted-foreground/40 placeholder:font-normal"
      )}
    />
  );

  const properties = readonly ? (
    <div className="flex flex-col gap-2">
      <PropertyRow icon={<CalendarDays className="size-3.5" />}>
        <span className="text-sm text-foreground">
          {dateValue.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}
        </span>
      </PropertyRow>
      <PropertyRow icon={<CalendarDays className="size-3.5" />}>
        <span className="text-sm text-foreground">{timeValue}</span>
      </PropertyRow>
      <PropertyRow icon={<RepeatIcon className="size-3.5" />}>
        <span className="text-sm text-foreground">
          {repeatEnabled ? `Every ${repeatCount} ${unitLabel(repeatUnit, parseInt(repeatCount, 10) || 1)}` : "Does not repeat"}
        </span>
      </PropertyRow>
      {repeatEnabled && stopDate && (
        <PropertyRow icon={<CalendarOff className="size-3.5" />}>
          <span className="text-sm text-foreground">
            Until {stopDate.toLocaleDateString()}
          </span>
        </PropertyRow>
      )}
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <PropertyRow icon={<User className="size-3.5" />}>
        <Select
          value={agentId}
          onValueChange={(val) => { if (val) setAgentId(val); }}
          items={agents.map((a) => ({ value: a.id, label: a.name }))}
        >
          <SelectTrigger className="h-7 w-auto border-none bg-transparent px-2 shadow-none text-sm text-foreground hover:bg-accent transition-colors rounded-md">
            <SelectValue placeholder={agents.length === 0 ? "No agents" : "Select agent"} />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropertyRow>

      <PropertyRow icon={<CalendarDays className="size-3.5" />}>
        <CalendarDatePicker
          value={dateValue}
          onChange={(d) => setDateValue(d)}
          ariaLabel="Event date"
          hideIcon
          className={GHOST_CONTROL}
        />
      </PropertyRow>

      <PropertyRow
        icon={
          <CalendarTimePicker
            value={timeValue}
            onChange={setTimeValue}
            iconOnly
            ariaLabel="Pick time slot"
            className="inline-flex size-6 items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-hover:bg-accent group-hover:text-foreground"
          />
        }
      >
        <input
          type="text"
          inputMode="numeric"
          pattern="([01]\d|2[0-3]):[0-5]\d"
          maxLength={5}
          value={timeValue}
          onChange={(e) => setTimeValue(e.target.value)}
          placeholder="HH:MM"
          aria-label="Event time (24-hour)"
          className={TIME_INPUT}
        />
      </PropertyRow>

      <PropertyRow icon={<RepeatIcon className="size-3.5" />}>
        {!repeatEnabled ? (
          <Select
            value=""
            onValueChange={(val) => {
              if (!val) return;
              if (val === "__custom__") {
                setRepeatEnabled(true);
                setRepeatCount("1");
                setRepeatUnit("day");
              } else {
                const parsed = parseRepeatInterval(val);
                if (parsed) {
                  setRepeatEnabled(true);
                  setRepeatCount(String(parsed.count));
                  setRepeatUnit(parsed.unit);
                }
              }
            }}
            items={[
              { value: "", label: "Does not repeat" },
              ...PRESET_INTERVALS.map((o) => ({ value: o.value, label: o.label })),
              { value: "__custom__", label: "Custom…" },
            ]}
          >
            <SelectTrigger className="h-7 w-auto border-none bg-transparent px-2 shadow-none text-sm text-foreground hover:bg-accent transition-colors rounded-md">
              <SelectValue placeholder="Does not repeat" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Does not repeat</SelectItem>
              {PRESET_INTERVALS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
              <SelectItem value="__custom__">Custom…</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <div className="-ml-2 flex items-center gap-1">
            <span className="px-1 text-sm text-foreground">Every</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="Repeat count"
              value={repeatCount}
              onChange={(e) => {
                setRepeatCount(e.target.value.replace(/[^\d]/g, ""));
              }}
              onBlur={() => {
                const n = parseInt(repeatCount, 10);
                if (!n || n < 1) setRepeatCount("1");
              }}
              maxLength={4}
              style={{ width: `${Math.max(1, repeatCount.length) + 1.5}ch` }}
              className="h-7 shrink-0 border-0 bg-transparent px-0 text-center text-sm tabular-nums text-foreground rounded-md outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-0 transition-colors"
            />
            <Select
              value={repeatUnit}
              onValueChange={(val) => { if (val && isValidUnit(val)) setRepeatUnit(val); }}
              items={REPEAT_UNITS.map((u) => ({ value: u, label: unitLabel(u, parseInt(repeatCount, 10) || 1) }))}
            >
              <SelectTrigger className="h-7 w-auto border-none bg-transparent px-1 shadow-none text-sm text-foreground hover:bg-accent transition-colors rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEAT_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {unitLabel(u, parseInt(repeatCount, 10) || 1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              aria-label="Remove repeat"
              onClick={() => {
                setRepeatEnabled(false);
                setRepeatCount("1");
                setRepeatUnit("day");
                setStopDate(null);
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
      </PropertyRow>

      {repeat && (
        <PropertyRow icon={<CalendarOff className="size-3.5" />}>
          <CalendarDatePicker
            value={stopDate}
            onChange={(d) => setStopDate(d)}
            onClear={() => setStopDate(null)}
            placeholder="No end date"
            min={dateValue}
            ariaLabel="Stop date"
            hideIcon
            className={GHOST_CONTROL}
          />
        </PropertyRow>
      )}
    </div>
  );

  const descriptionEditor = readonly ? (
    description ? (
      <pre className="whitespace-pre-wrap font-sans text-sm">{description}</pre>
    ) : null
  ) : (
    <div ref={descriptionRef}>
      <MarkdownEditor
        key={resolvedEvent?.id ?? "new"}
        contentType="markdown"
        value={description}
        onChange={setDescription}
        placeholder="Add a description…"
        className="markdown"
        minHeight={mode === "edit" ? "10rem" : "8rem"}
        variant="seamless"
        agents={agents}
      />
    </div>
  );

  const dragHandle = (
    <SheetResizeHandle onPointerDown={onDragPointerDown} onPointerMove={onDragPointerMove} onPointerUp={onDragPointerUp} />
  );

  const sheetBody = fetchLoading ? (
    <SheetBody className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </SheetBody>
  ) : (
    <SheetBody className="flex flex-col gap-6 px-4 pt-6 pb-4 sm:px-8 sm:pt-10 sm:pb-6">
      {titleInput}
      {properties}
      {descriptionEditor}
    </SheetBody>
  );

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          style={{ width: `min(${sheetWidth}px, 100vw)`, maxWidth: "none" }}
          className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
        >
          {dragHandle}
          <SheetTitle className="sr-only">{a11yTitle}</SheetTitle>
          {readonly ? (
            <div className="flex flex-1 flex-col min-h-0">
              {sheetBody}
            </div>
          ) : mode === "create" ? (
            <form
              ref={formRef}
              onSubmit={handleCreateSubmit}
              onKeyDownCapture={handleSubmitShortcut}
              className="flex flex-1 flex-col min-h-0"
            >
              {sheetBody}
              <SheetFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !agents.length}>
                  {submitting ? "Creating..." : (
                    <>
                      {inlineSubmitHint}
                      Create event
                    </>
                  )}
                </Button>
              </SheetFooter>
            </form>
          ) : (
            <div
              onKeyDownCapture={handleSubmitShortcut}
              className="flex flex-1 flex-col min-h-0"
            >
              {sheetBody}
              <SheetFooter className="sm:justify-between">
                <Button
                  variant="destructive"
                  onClick={handleDeleteClick}
                  disabled={deleting || saving}
                >
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
                <div className="flex items-center gap-2 sm:justify-end">
                  <Button
                    variant="outline"
                    onClick={() => handleOpenChange(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleEditSave}
                    disabled={saving || !dirty}
                  >
                    {saving ? "Saving..." : (
                      <>
                        {inlineSubmitHint}
                        Save
                      </>
                    )}
                  </Button>
                </div>
              </SheetFooter>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <RecurringScopeDialog
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        onConfirm={handleScopeConfirm}
        loading={saving}
        title="Update recurring event"
        description="How should this change apply?"
        confirmLabel="Update"
        loadingLabel="Saving..."
      />
      <RecurringScopeDialog
        open={deleteScopeOpen}
        onOpenChange={setDeleteScopeOpen}
        onConfirm={handleDeleteScopeConfirm}
        loading={deleting}
        title="Delete recurring event"
        description="How much of the series should be removed?"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        confirmVariant="destructive"
      />
    </>
  );
}
