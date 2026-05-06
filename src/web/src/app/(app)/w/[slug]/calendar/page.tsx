"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
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
  const { workspaceId } = useWorkspace();
  const { agents } = useAgentContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = new Date();
  const initialYear = Number(searchParams.get("y")) || now.getFullYear();
  const initialMonth = searchParams.has("m")
    ? Number(searchParams.get("m"))
    : now.getMonth();
  const initialView = parseCalendarView(searchParams.get("view"));

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [view, setView] = useState<CalendarView>(initialView);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(() => {
    const param = searchParams.get("agents");
    if (!param) return new Set();
    return new Set(param.split(",").filter(Boolean));
  });
  // Default focus to today when the current view contains today, otherwise the
  // 1st of the viewed month — keeps at least one day cell in the tab order.
  const [focusedDate, setFocusedDate] = useState<Date>(() => {
    const t = new Date();
    if (t.getFullYear() === initialYear && t.getMonth() === initialMonth) return t;
    return new Date(initialYear, initialMonth, 1);
  });
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => {
    if (initialView === "week" && searchParams.has("d")) {
      const d = Number(searchParams.get("d"));
      return getWeekStart(new Date(initialYear, initialMonth, d));
    }
    return getWeekStart(new Date());
  });
  const [openPopoverKey, setOpenPopoverKey] = useState<string | null>(null);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefault, setCreateDefault] = useState<Date | undefined>();
  const [detail, setDetail] = useState<CalendarEvent | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const fetchEvents = useCallback(async () => {
    const { from, to } =
      view === "week"
        ? weekRangeIso(weekAnchor)
        : gridRangeIso(year, month);
    setLoading(true);
    try {
      const list = await listCalendarEvents(workspaceId, { from, to });
      setEvents(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, year, month, view, weekAnchor]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

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
  }, [month, year, selectedAgents, view, syncUrl]);

  const handleNext = useCallback(() => {
    const nm = month === 11 ? 0 : month + 1;
    const ny = month === 11 ? year + 1 : year;
    setMonth(nm);
    setYear(ny);
    setFocusedDate(new Date(ny, nm, 1));
    syncUrl(ny, nm, selectedAgents, view);
  }, [month, year, selectedAgents, view, syncUrl]);

  const handlePrevWeek = useCallback(() => {
    const prev = new Date(weekAnchor);
    prev.setDate(prev.getDate() - 7);
    setWeekAnchor(prev);
    setFocusedDate(prev);
    syncUrl(prev.getFullYear(), prev.getMonth(), selectedAgents, "week", prev);
  }, [weekAnchor, selectedAgents, syncUrl]);

  const handleNextWeek = useCallback(() => {
    const next = new Date(weekAnchor);
    next.setDate(next.getDate() + 7);
    setWeekAnchor(next);
    setFocusedDate(next);
    syncUrl(next.getFullYear(), next.getMonth(), selectedAgents, "week", next);
  }, [weekAnchor, selectedAgents, syncUrl]);

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
    setDetail(ev);
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
    [selectedAgents, view, syncUrl]
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
  }, [jumpToDate, view, selectedAgents, syncUrl]);

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
    [year, month, selectedAgents, syncUrl, focusedDate, view, weekAnchor]
  );

  const handleCreate = async (values: {
    agent_id: string;
    title: string;
    description?: string;
    scheduled_at: string;
    repeat_interval?: string;
    repeat_stop_date?: string;
  }) => {
    setSubmitting(true);
    try {
      const created = await createCalendarEvent(values, workspaceId);
      const { from, to } =
        view === "week"
          ? weekRangeIso(weekAnchor)
          : gridRangeIso(year, month);
      const createdAt = new Date(created.scheduled_at).getTime();
      if (
        createdAt >= new Date(from).getTime() &&
        createdAt <= new Date(to).getTime()
      ) {
        setEvents((prev) => [...prev, created]);
      }
      setCreateOpen(false);
      toast.success("Event created");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create event"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (
    event: CalendarEvent,
    patch: UpdateCalendarEventRequest
  ) => {
    setSubmittingEdit(true);
    try {
      await updateCalendarEvent(event.id, patch, workspaceId);
      // Recurring split may have created a detached row and advanced the
      // parent — simplest to re-fetch the visible range rather than merge.
      await fetchEvents();
      setDetailOpen(false);
      setDetail(null);
      toast.success("Event updated");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update event"
      );
    } finally {
      setSubmittingEdit(false);
    }
  };

  const handleDelete = async (
    event: CalendarEvent,
    args?: { scope?: "this" | "following"; occurrence_at?: string }
  ) => {
    setDeletingId(event.id);
    try {
      await deleteCalendarEvent(event.id, workspaceId, args);
      if (args?.scope) {
        // Scoped deletes may keep the parent row alive (advance scheduled_at,
        // append exception, clip repeat_stop_at) — refetch so the grid shows
        // the new series state instead of optimistically removing the row.
        await fetchEvents();
      } else {
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
      }
      setDetailOpen(false);
      setDetail(null);
      toast.success("Event deleted");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete event"
      );
    } finally {
      setDeletingId(null);
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
  }, [view, year, month, focusedDate, jumpToDate, hiddenCountForDate, weekAnchor, selectedAgents, syncUrl]);

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
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Calendar</h1>
          <p className="text-xs text-muted-foreground hidden md:block">
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
          >
            <Plus className="size-3.5" />
            New event
          </Button>
        </div>
      </div>

      <div className={cn(
        "flex flex-1 flex-col gap-4 px-5 py-5",
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
