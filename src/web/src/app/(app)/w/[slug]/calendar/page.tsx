"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQuery, useMutation, skipToken, type QueryKey } from "@tanstack/react-query";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { captureApplicationOwner, assertApplicationOwner } from "@/lib/application-owner";
import { isAbortError } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspaceOwner } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

import {
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "@/lib/api";
import {
  CalendarMonthGrid,
  buildMonthCells,
  dateKey,
  stepDate,
} from "@/components/calendar/calendar-month-grid";
import { CalendarAgenda } from "@/components/calendar/calendar-agenda";
import { CalendarWeekGrid } from "@/components/calendar/calendar-week-grid";
import {
  CalendarViewSwitcher,
  parseCalendarView,
  type CalendarView,
} from "@/components/calendar/calendar-view-switcher";
import { CalendarAgentFilter } from "@/components/calendar/calendar-agent-filter";
import { CalendarEventSheet } from "@/components/calendar/calendar-event-sheet";
import { getWeekStart, weekRangeIso } from "@/components/calendar/calendar-week-utils";
import type { CalendarEvent, UpdateCalendarEventRequest } from "@alook/shared";
import { isTypingTarget } from "@/components/calendar/keyboard";
import { useIsMobile } from "@/hooks/use-mobile";
import { trackCalendarEventCreated } from "@/lib/analytics";

/**
 * The month grid always renders six full weeks (42 cells), which means the
 * first and last rows usually include leading/trailing days from adjacent
 * months. Fetch for the full visible grid — otherwise recurring occurrences
 * that land on those out-of-month cells would silently not render.
 */
function gridRangeIso(year: number, month: number) {
  const cells = buildMonthCells(year, month);
  const first = cells[0]!.date;
  const last = cells[cells.length - 1]!.date;
  const from = new Date(
    first.getFullYear(),
    first.getMonth(),
    first.getDate(),
    0,
    0,
    0,
    0
  );
  const to = new Date(
    last.getFullYear(),
    last.getMonth(),
    last.getDate(),
    23,
    59,
    59,
    999
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function CalendarPage() {
  const owner = useWorkspaceOwner();
  const { workspaceId } = owner;
  const { agents, subscribeWs } = useAgentContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const now = new Date();
  const initialYear = Number(searchParams.get("y")) || now.getFullYear();
  const initialMonth = searchParams.has("m")
    ? Number(searchParams.get("m"))
    : now.getMonth();
  const initialView = parseCalendarView(searchParams.get("view"));

  const [year, setYear] = useAtom(useCreateAtom(initialYear));
  const [month, setMonth] = useAtom(useCreateAtom(initialMonth));
  const [view, setView] = useAtom(useCreateAtom<CalendarView>(initialView));
  const [selectedAgents, setSelectedAgents] = useAtom(useCreateAtom<Set<string>>(useMemo<Set<string>>(() => {
    const param = searchParams.get("agents");
    if (!param) return new Set();
    return new Set(param.split(",").filter(Boolean));
  }, [searchParams])));
  // Default focus to today when the current view contains today, otherwise the
  // 1st of the viewed month — keeps at least one day cell in the tab order.
  const [focusedDate, setFocusedDate] = useAtom(useCreateAtom<Date>(useMemo<Date>(() => {
    const t = new Date();
    if (t.getFullYear() === initialYear && t.getMonth() === initialMonth) return t;
    return new Date(initialYear, initialMonth, 1);
  }, [initialMonth, initialYear])));
  const [weekAnchor, setWeekAnchor] = useAtom(useCreateAtom<Date>(useMemo<Date>(() => {
    if (initialView === "week" && searchParams.has("d")) {
      const d = Number(searchParams.get("d"));
      return getWeekStart(new Date(initialYear, initialMonth, d));
    }
    return getWeekStart(new Date());
  }, [initialMonth, initialView, initialYear, searchParams])));
  const [openPopoverKey, setOpenPopoverKey] = useAtom(useCreateAtom<string | null>(null));

  const [createOpen, setCreateOpen] = useAtom(useCreateAtom(false));
  const [createDefault, setCreateDefault] = useAtom(useCreateAtom<Date | undefined>(undefined));
  const [detailSelection, setDetailSelection] = useAtom(useCreateAtom<{ key: QueryKey; id: string; occurrence: string | null } | null>(null));
  const [detailOpen, setDetailOpen] = useAtom(useCreateAtom(false));

  const syncUrl = useCallback(
    (
      nextYear: number,
      nextMonth: number,
      agentSet: Set<string>,
      nextView: CalendarView,
      weekAnchorDate?: Date | null
    ) => {
      const params = new URLSearchParams();
      params.set("y", String(nextYear));
      params.set("m", String(nextMonth));
      if (agentSet.size > 0) params.set("agents", [...agentSet].join(","));
      if (nextView !== "month") params.set("view", nextView);
      if (nextView === "week" && weekAnchorDate) {
        params.set("d", String(weekAnchorDate.getDate()));
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router]
  );

  const range = useMemo(() => view === "week" ? weekRangeIso(weekAnchor) : gridRangeIso(year, month), [view, weekAnchor, year, month]);
  const source = useWorkspaceViewSource(owner, `calendar:${range.from}:${range.to}:${detailSelection?.id ?? ""}:${detailSelection?.occurrence ?? ""}:${detailOpen}:${createOpen}`, true);
  const eventsKey = useMemo(() => owner.key("calendar", "range", range.from, range.to), [owner, range.from, range.to]);
  const eventsQuery = useQuery({ queryKey: eventsKey, queryFn: ({ signal }) => listCalendarEvents(workspaceId, range, source.request(signal)) });
  const events = eventsQuery.data ?? EMPTY_EVENTS;
  const loading = eventsQuery.isPending;
  const detail = useQuery({ queryKey: detailSelection?.key ?? owner.key("calendar", "range", "__none__"), queryFn: detailSelection ? ({ signal, queryKey }) => listCalendarEvents(workspaceId, { from: String(queryKey[6]), to: String(queryKey[7]) }, source.request(signal)) : skipToken, enabled: false,
    select: (rows: CalendarEvent[]) => rows.find((row) => row.id === detailSelection?.id && (row.occurrence_at ?? null) === detailSelection?.occurrence) ?? null,
  }).data ?? null;
  const fetchEvents = useCallback(() => owner.queryClient.invalidateQueries({ queryKey: eventsKey, exact: true }), [owner, eventsKey]);
  useEffect(() => {
    if (!eventsQuery.error || eventsQuery.isFetching || isAbortError(eventsQuery.error)) return;
    try { source.assertActive(); } catch { return; }
    toast.error(eventsQuery.error instanceof Error ? eventsQuery.error.message : "Failed to load events");
  }, [eventsQuery.error, eventsQuery.isFetching, source, source.assertActive]);
  useEffect(() => subscribeWs((message) => {
    try { source.assertActive(); } catch { return; }
    if (message.type.startsWith("calendar.")) void owner.queryClient.invalidateQueries({ queryKey: owner.key("calendar") });
  }), [owner, subscribeWs, source.assertActive, source]);
  const calendarMutation = useMutation({ mutationFn: ({ operation }: { operation: () => Promise<unknown>; kind: "create" | "update" | "delete"; id?: string; assertActive: () => void }) => operation() });
  const currentMutation = calendarMutation.isPending && calendarMutation.variables.assertActive === source.assertActive;
  const submitting = currentMutation && calendarMutation.variables.kind === "create";
  const submittingEdit = currentMutation && calendarMutation.variables.kind === "update";
  const deletingId = currentMutation && calendarMutation.variables.kind === "delete" ? calendarMutation.variables.id : null;
  const mutateCalendar = calendarMutation.mutateAsync;
  const settleFacts = () => {
    const token = captureApplicationOwner(owner.application);
    const resource = owner.queryClient.getQueryCache().find({ queryKey: eventsKey, exact: true });
    return () => {
      try { assertApplicationOwner(token); } catch { return; }
      if (resource && owner.queryClient.getQueryCache().find({ queryKey: eventsKey, exact: true }) === resource) void owner.queryClient.invalidateQueries({ queryKey: eventsKey, exact: true, refetchType: "none" });
    };
  };

  const visibleEvents = useMemo(() => {
    if (selectedAgents.size === 0) return events;
    return events.filter((ev) => selectedAgents.has(ev.agent_id));
  }, [events, selectedAgents]);

  const handlePrev = useCallback(() => {
    const nm = month === 0 ? 11 : month - 1;
    const ny = month === 0 ? year - 1 : year;
    setMonth(nm);
    setYear(ny);
    setFocusedDate(new Date(ny, nm, 1));
    syncUrl(ny, nm, selectedAgents, view);
  }, [month, year, setMonth, setYear, setFocusedDate, syncUrl, selectedAgents, view]);

  const handleNext = useCallback(() => {
    const nm = month === 11 ? 0 : month + 1;
    const ny = month === 11 ? year + 1 : year;
    setMonth(nm);
    setYear(ny);
    setFocusedDate(new Date(ny, nm, 1));
    syncUrl(ny, nm, selectedAgents, view);
  }, [month, year, setMonth, setYear, setFocusedDate, syncUrl, selectedAgents, view]);

  const handlePrevWeek = useCallback(() => {
    const prev = new Date(weekAnchor);
    prev.setDate(prev.getDate() - 7);
    setWeekAnchor(prev);
    setFocusedDate(prev);
    syncUrl(prev.getFullYear(), prev.getMonth(), selectedAgents, "week", prev);
  }, [weekAnchor, setWeekAnchor, setFocusedDate, syncUrl, selectedAgents]);

  const handleNextWeek = useCallback(() => {
    const next = new Date(weekAnchor);
    next.setDate(next.getDate() + 7);
    setWeekAnchor(next);
    setFocusedDate(next);
    syncUrl(next.getFullYear(), next.getMonth(), selectedAgents, "week", next);
  }, [weekAnchor, setWeekAnchor, setFocusedDate, syncUrl, selectedAgents]);

  const handleToggleAgent = (agentId: string) => {
    const next = new Set(selectedAgents);
    if (next.has(agentId)) next.delete(agentId);
    else next.add(agentId);
    setSelectedAgents(next);
    syncUrl(year, month, next, view, view === "week" ? weekAnchor : null);
  };

  const handleSelectDay = (date: Date) => {
    setCreateDefault(date);
    setCreateOpen(true);
    setFocusedDate(date);
  };

  const handleSelectEvent = (ev: CalendarEvent) => {
    setDetailSelection({ key: eventsKey, id: ev.id, occurrence: ev.occurrence_at ?? null });
    setDetailOpen(true);
  };

  const jumpToDate = useCallback(
    (date: Date) => {
      const ny = date.getFullYear();
      const nm = date.getMonth();
      setYear(ny);
      setMonth(nm);
      setFocusedDate(date);
      if (view === "week") {
        const anchor = getWeekStart(date);
        setWeekAnchor(anchor);
        syncUrl(ny, nm, selectedAgents, view, anchor);
      } else {
        syncUrl(ny, nm, selectedAgents, view);
      }
    },
    [setYear, setMonth, setFocusedDate, view, setWeekAnchor, syncUrl, selectedAgents]
  );

  const handleJumpToToday = useCallback(() => {
    const today = new Date();
    if (view === "week") {
      const anchor = getWeekStart(today);
      setWeekAnchor(anchor);
      setFocusedDate(today);
      syncUrl(anchor.getFullYear(), anchor.getMonth(), selectedAgents, "week", anchor);
    } else {
      jumpToDate(today);
    }
  }, [view, setWeekAnchor, setFocusedDate, syncUrl, selectedAgents, jumpToDate]);

  const handleViewChange = useCallback(
    (v: CalendarView) => {
      setView(v);
      if (v === "week") {
        const anchor = getWeekStart(focusedDate);
        setWeekAnchor(anchor);
        syncUrl(year, month, selectedAgents, v, anchor);
      } else if (view === "week") {
        const ny = weekAnchor.getFullYear();
        const nm = weekAnchor.getMonth();
        setYear(ny);
        setMonth(nm);
        syncUrl(ny, nm, selectedAgents, v);
      } else {
        syncUrl(year, month, selectedAgents, v);
      }
    },
    [setView, view, focusedDate, setWeekAnchor, syncUrl, year, month, selectedAgents, weekAnchor, setYear, setMonth]
  );

  const handleCreate = async (values: {
    agent_id: string;
    title: string;
    description?: string;
    scheduled_at: string;
    repeat_interval?: string;
    repeat_stop_date?: string;
  }) => {
    const assertActive = source.assertActive; const settle = settleFacts();
    assertActive();
    try {
      const created = await mutateCalendar({ kind: "create", assertActive, operation: async () => { await owner.queryClient.cancelQueries({ queryKey: owner.key("calendar", "range") }); assertActive(); return createCalendarEvent(values, workspaceId, { assertActive }); } }) as CalendarEvent;
      assertActive();
      trackCalendarEventCreated({
        agent_id: values.agent_id,
        is_recurring: !!values.repeat_interval,
      });
      const { from, to } =
        view === "week"
          ? weekRangeIso(weekAnchor)
          : gridRangeIso(year, month);
      const createdAt = new Date(created.scheduled_at).getTime();
      if (
        createdAt >= new Date(from).getTime() &&
        createdAt <= new Date(to).getTime()
      ) {
        owner.queryClient.setQueryData<CalendarEvent[]>(eventsKey, (prev) => [...prev ?? [], created]);
      }
      setCreateOpen(false);
      toast.success("Event created");
    } catch (err) {
      if (isAbortError(err)) return;
      try { assertActive(); } catch { return; }
      toast.error(
        err instanceof Error ? err.message : "Failed to create event"
      );
    } finally {
      settle();
    }
  };

  const handleUpdate = async (
    event: CalendarEvent,
    patch: UpdateCalendarEventRequest
  ) => {
    const assertActive = source.assertActive; const settle = settleFacts();
    assertActive();
    try {
      await mutateCalendar({ kind: "update", id: event.id, assertActive, operation: async () => { await owner.queryClient.cancelQueries({ queryKey: owner.key("calendar", "range") }); assertActive(); return updateCalendarEvent(event.id, patch, workspaceId, { assertActive }); } });
      assertActive();
      // Recurring split may have created a detached row and advanced the
      // parent — simplest to re-fetch the visible range rather than merge.
      await fetchEvents();
      assertActive();
      setDetailOpen(false);
      setDetailSelection(null);
      toast.success("Event updated");
    } catch (err) {
      if (isAbortError(err)) return;
      try { assertActive(); } catch { return; }
      toast.error(
        err instanceof Error ? err.message : "Failed to update event"
      );
    } finally {
      settle();
    }
  };

  const handleDelete = async (
    event: CalendarEvent,
    args?: { scope?: "this" | "following"; occurrence_at?: string }
  ) => {
    const assertActive = source.assertActive; const settle = settleFacts();
    assertActive();
    try {
      await mutateCalendar({ kind: "delete", id: event.id, assertActive, operation: async () => { await owner.queryClient.cancelQueries({ queryKey: owner.key("calendar", "range") }); assertActive(); return deleteCalendarEvent(event.id, workspaceId, args, { assertActive }); } });
      assertActive();
      if (args?.scope) {
        // Scoped deletes may keep the parent row alive (advance scheduled_at,
        // append exception, clip repeat_stop_at) — refetch so the grid shows
        // the new series state instead of optimistically removing the row.
        await fetchEvents();
      assertActive();
      } else {
        owner.queryClient.setQueryData<CalendarEvent[]>(eventsKey, (prev) => prev?.filter((e) => e.id !== event.id));
      }
      setDetailOpen(false);
      setDetailSelection(null);
      toast.success("Event deleted");
    } catch (err) {
      if (isAbortError(err)) return;
      try { assertActive(); } catch { return; }
      toast.error(
        err instanceof Error ? err.message : "Failed to delete event"
      );
    } finally {
      settle();
    }
  };

  // Global keyboard handler — month view only. Page-level so `n`/`t` fire even
  // when the grid isn't focused. Arrow keys only move focus if it's already in
  // the grid.
  const createOpenRef = useRef(createOpen);
  const detailOpenRef = useRef(detailOpen);
  useEffect(() => {
    createOpenRef.current = createOpen;
  }, [createOpen]);
  useEffect(() => {
    detailOpenRef.current = detailOpen;
  }, [detailOpen]);

  // Memoize events-per-day for quick lookup in the keyboard handler.
  const hiddenCountForDate = useCallback(
    (d: Date) => {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let count = 0;
      for (const ev of visibleEvents) {
        const ed = new Date(ev.scheduled_at);
        const k = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, "0")}-${String(ed.getDate()).padStart(2, "0")}`;
        if (k === key) count++;
      }
      return Math.max(0, count - 3);
    },
    [visibleEvents]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (createOpenRef.current || detailOpenRef.current) return;
      if (isTypingTarget(e.target)) return;

      // `t` and `n` fire in every view.
      if (e.key === "t") {
        e.preventDefault();
        const today = new Date();
        if (view === "week") {
          const anchor = getWeekStart(today);
          setWeekAnchor(anchor);
          setFocusedDate(today);
          syncUrl(anchor.getFullYear(), anchor.getMonth(), selectedAgents, "week", anchor);
        } else if (today.getFullYear() !== year || today.getMonth() !== month) {
          jumpToDate(today);
        } else {
          setFocusedDate(today);
        }
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        const target = focusedDate;
        setCreateDefault(target);
        setCreateOpen(true);
        return;
      }

      // Arrow / Enter / Page / Home / End are for month and week views only.
      if (view !== "month" && view !== "week") return;

      if (view === "week") {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          const next = new Date(focusedDate);
          next.setDate(next.getDate() - 1);
          setFocusedDate(next);
          const anchor = getWeekStart(next);
          if (anchor.getTime() !== weekAnchor.getTime()) {
            setWeekAnchor(anchor);
            syncUrl(anchor.getFullYear(), anchor.getMonth(), selectedAgents, "week", anchor);
          }
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const next = new Date(focusedDate);
          next.setDate(next.getDate() + 1);
          setFocusedDate(next);
          const anchor = getWeekStart(next);
          if (anchor.getTime() !== weekAnchor.getTime()) {
            setWeekAnchor(anchor);
            syncUrl(anchor.getFullYear(), anchor.getMonth(), selectedAgents, "week", anchor);
          }
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const next = new Date(focusedDate);
          next.setHours(next.getHours() - 1);
          setFocusedDate(next);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const next = new Date(focusedDate);
          next.setHours(next.getHours() + 1);
          setFocusedDate(next);
          return;
        }
        return;
      }

      const focusInGrid =
        document.activeElement?.getAttribute("role") === "gridcell";

      if (e.key === "Enter") {
        if (!focusInGrid) return;
        e.preventDefault();
        const hidden = hiddenCountForDate(focusedDate);
        if (hidden > 0) {
          const key = `${focusedDate.getFullYear()}-${String(focusedDate.getMonth() + 1).padStart(2, "0")}-${String(focusedDate.getDate()).padStart(2, "0")}`;
          setOpenPopoverKey(key);
        } else {
          setCreateDefault(focusedDate);
          setCreateOpen(true);
        }
        return;
      }

      // Escape is handled by base-ui popover / dialog primitives internally.

      if (!focusInGrid) return;

      const stepped = stepDate(focusedDate, e.key);
      if (!stepped) return;
      e.preventDefault();
      const inView =
        stepped.getFullYear() === year && stepped.getMonth() === month;
      if (inView) {
        setFocusedDate(stepped);
      } else {
        jumpToDate(stepped);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, year, month, focusedDate, jumpToDate, hiddenCountForDate, weekAnchor, selectedAgents, syncUrl, setWeekAnchor, setFocusedDate, setCreateDefault, setCreateOpen, setOpenPopoverKey]);

  // When focusedDate changes, move DOM focus onto that cell — but only if
  // focus is already inside the grid (don't steal focus on page load).
  useEffect(() => {
    if (view !== "month") return;
    const active = document.activeElement;
    if (!active || active.getAttribute("role") !== "gridcell") return;
    const sel = `[data-date="${dateKey(focusedDate)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    el?.focus();
  }, [focusedDate, view, year, month]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Calendar</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            Schedule recurring and one-time tasks for your agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CalendarViewSwitcher view={view} onChange={handleViewChange} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCreateDefault(undefined);
              setCreateOpen(true);
            }}
            disabled={agents.length === 0}
            className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0"
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">New event</span>
          </Button>
        </div>
      </div>

      <div className={cn(
        "flex flex-1 flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4",
        view === "week" ? "min-h-0 overflow-hidden" : "overflow-y-auto"
      )}>
        <CalendarAgentFilter
          agents={agents}
          selected={selectedAgents}
          onToggle={handleToggleAgent}
        />

        {view === "month" && (
          <CalendarMonthGrid
            year={year}
            month={month}
            events={visibleEvents}
            agents={agents}
            loading={loading}
            focusedDate={focusedDate}
            openPopoverKey={openPopoverKey}
            onPopoverChange={setOpenPopoverKey}
            onPrev={handlePrev}
            onNext={handleNext}
            onJumpToToday={handleJumpToToday}
            onJumpToDate={jumpToDate}
            onSelectDay={handleSelectDay}
            onSelectEvent={handleSelectEvent}
          />
        )}

        {view === "week" && (
          <CalendarWeekGrid
            weekStart={weekAnchor}
            events={visibleEvents}
            agents={agents}
            loading={loading}
            focusedDate={focusedDate}
            compact={isMobile}
            onPrevWeek={handlePrevWeek}
            onNextWeek={handleNextWeek}
            onJumpToToday={handleJumpToToday}
            onJumpToDate={jumpToDate}
            onSelectSlot={(date, hour) => {
              const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
              setCreateDefault(target);
              setCreateOpen(true);
            }}
            onSelectEvent={handleSelectEvent}
          />
        )}

        {view === "agenda" && (
          <CalendarAgenda
            events={visibleEvents}
            agents={agents}
            loading={loading}
            onSelectEvent={handleSelectEvent}
          />
        )}

        {(view === "month" || view === "week") &&
          !loading &&
          events.length > 0 &&
          visibleEvents.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-4">
              No events for selected agents.
            </p>
          )}
      </div>

      <CalendarEventSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        defaultDate={createDefault}
        submitting={submitting}
        onCreate={handleCreate}
      />

      <CalendarEventSheet
        event={detail}
        agents={agents}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        deleting={deletingId === detail?.id}
        saving={submittingEdit}
      />
    </>
  );
}

const EMPTY_EVENTS: CalendarEvent[] = [];
