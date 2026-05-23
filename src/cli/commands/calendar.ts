import { Command } from "commander";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { printJSON } from "../lib/output.js";
import { cmdPrefix } from "../lib/env.js";
import { resolveAgentId } from "../lib/flags.js";

interface CalendarEventResponse {
  id: string;
  agent_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  occurrence_at?: string;
  collapsed_count?: number | null;
  repeat_interval: string | null;
  repeat_stop_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

function resolveClientOpts(command: Command, agentId: string) {
  const parentOpts = command.parent?.parent?.opts() || {};
  const profile: string | undefined = parentOpts.profile;
  const cfg = loadCLIConfigForProfile(profile);
  const serverUrl = parentOpts.server || cfg.server_url;
  const workspaces = cfg.watched_workspaces || [];

  const ws = workspaces.find((w) => w.agent_ids?.includes(agentId));
  if (!ws || !ws.token) {
    console.error(
      `Error: no registered workspace contains agent ${agentId}. Run '${cmdPrefix()} register --token <token>' first.`
    );
    process.exit(1);
  }
  return { serverUrl, token: ws.token, workspaceId: ws.id };
}

function parseLocalDatetime(input: string): string {
  // Accepts YYYY-MM-DDTHH:MM and interprets as local time.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    input
  );
  if (!match) {
    throw new Error(
      `invalid --datetime "${input}" — expected YYYY-MM-DDTHH:MM`
    );
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0
  );
  return date.toISOString();
}

function formatLocalDatetime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printEventDetail(ev: CalendarEventResponse): void {
  console.log(`id:            ${ev.id}`);
  console.log(`agent_id:      ${ev.agent_id}`);
  console.log(`title:         ${ev.title}`);
  console.log(`scheduled_at:  ${formatLocalDatetime(ev.scheduled_at)}`);
  if (ev.repeat_interval) {
    const until = ev.repeat_stop_at
      ? ` until ${formatLocalDatetime(ev.repeat_stop_at)}`
      : "";
    console.log(`repeat:        every ${ev.repeat_interval}${until}`);
  } else {
    console.log(`repeat:        (none)`);
  }
  console.log(
    `last_fired_at: ${
      ev.last_triggered_at ? formatLocalDatetime(ev.last_triggered_at) : "(never)"
    }`
  );
  console.log("description:");
  console.log(ev.description ?? "(no description)");
}

export function calendarCommand(): Command {
  const cmd = new Command("calendar").description(
    "Manage scheduled agent events"
  );

  cmd
    .command("set")
    .description("Create a calendar event")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--event_title <title>", "Event title (used as the task prompt)")
    .requiredOption(
      "--datetime <iso>",
      "Scheduled datetime (YYYY-MM-DDTHH:MM, local time)"
    )
    .option("--description <text>", "Optional longer-form notes for the event")
    .option("--repeat <interval>", "Repeat interval, e.g. 1day, 2hour, 1month")
    .option(
      "--repeat_stop_date <date>",
      "Stop repeating on or after this date (YYYY-MM-DD, local time)"
    )
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(
        command,
        agentId
      );
      const client = new APIClient(serverUrl, token, workspaceId);

      let scheduledAt: string;
      try {
        scheduledAt = parseLocalDatetime(opts.datetime);
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }

      if (opts.repeat_stop_date && !opts.repeat) {
        console.error("Error: --repeat_stop_date requires --repeat");
        process.exit(1);
      }
      if (opts.repeat_stop_date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.repeat_stop_date)) {
        console.error("Error: --repeat_stop_date must be YYYY-MM-DD");
        process.exit(1);
      }

      const body: Record<string, unknown> = {
        agent_id: agentId,
        title: opts.event_title,
        scheduled_at: scheduledAt,
      };
      if (opts.description) body.description = opts.description;
      if (opts.repeat) body.repeat_interval = opts.repeat;
      if (opts.repeat_stop_date) body.repeat_stop_date = opts.repeat_stop_date;
      if (process.env.ALOOK_CONVERSATION_ID) body.conversation_id = process.env.ALOOK_CONVERSATION_ID;

      try {
        const created = await client.postJSON<CalendarEventResponse>(
          "/api/calendar",
          body
        );
        if (opts.json) {
          printJSON(created);
          return;
        }
        console.log(
          `Created ${created.id} — ${created.title} @ ${formatLocalDatetime(
            created.scheduled_at
          )}${created.repeat_interval ? ` (every ${created.repeat_interval})` : ""}`
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List calendar events for an agent")
    .option("--agent_id <id>", "Agent ID")
    .option("--future_days <n>", "Include events scheduled in the next N days", "30")
    .option("--past_days <n>", "Include events scheduled in the past N days", "0")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(
        command,
        agentId
      );
      const client = new APIClient(serverUrl, token, workspaceId);

      const now = Date.now();
      const from = new Date(
        now - Number(opts.past_days) * 86_400_000
      ).toISOString();
      const to = new Date(
        now + Number(opts.future_days) * 86_400_000
      ).toISOString();

      try {
        const events = await client.getJSON<CalendarEventResponse[]>(
          `/api/calendar?agentId=${encodeURIComponent(agentId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        );
        if (opts.json) {
          printJSON(events);
          return;
        }
        if (events.length === 0) {
          console.log("No calendar events.");
          return;
        }
        for (const ev of events) {
          const repeatBadge = ev.repeat_interval
            ? ` [every ${ev.repeat_interval}${ev.collapsed_count ? ` · ${ev.collapsed_count} occurrences` : ""}${ev.repeat_stop_at ? ` until ${formatLocalDatetime(ev.repeat_stop_at)}` : ""}]`
            : "";
          const descBadge = ev.description ? " [has description]" : "";
          console.log(
            `${ev.id}  ${formatLocalDatetime(ev.scheduled_at)}  ${ev.title}${repeatBadge}${descBadge}`
          );
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("show")
    .description("Show the full detail of a single calendar event")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--event_id <id>", "Event ID")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(
        command,
        agentId
      );
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const ev = await client.getJSON<CalendarEventResponse>(
          `/api/calendar/${opts.event_id}`
        );
        if (ev.agent_id !== agentId) {
          console.error(
            `Error: event ${ev.id} does not belong to agent ${agentId}`
          );
          process.exit(1);
        }
        if (opts.json) {
          printJSON(ev);
          return;
        }
        printEventDetail(ev);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Update fields on an existing calendar event")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--event_id <id>", "Event ID")
    .option("--event_title <title>", "New event title (task prompt)")
    .option("--description <text>", "New description text")
    .option("--clear_description", "Remove the description (sets to null)")
    .option(
      "--datetime <iso>",
      "New scheduled datetime (YYYY-MM-DDTHH:MM, local time)"
    )
    .option("--repeat <interval>", "New repeat interval, e.g. 1day, 2hour")
    .option("--clear_repeat", "Convert a repeating event into a one-off")
    .option(
      "--repeat_stop_date <date>",
      "New stop date (YYYY-MM-DD, local time)"
    )
    .option("--clear_repeat_stop_date", "Remove the repeat stop date")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      if (opts.description && opts.clear_description) {
        console.error(
          "Error: --description and --clear_description are mutually exclusive"
        );
        process.exit(1);
      }
      if (opts.repeat && opts.clear_repeat) {
        console.error(
          "Error: --repeat and --clear_repeat are mutually exclusive"
        );
        process.exit(1);
      }
      if (opts.repeat_stop_date && opts.clear_repeat_stop_date) {
        console.error(
          "Error: --repeat_stop_date and --clear_repeat_stop_date are mutually exclusive"
        );
        process.exit(1);
      }

      const body: Record<string, unknown> = {};
      if (opts.event_title) body.title = opts.event_title;
      if (opts.description) body.description = opts.description;
      if (opts.clear_description) body.description = null;
      if (opts.datetime) {
        try {
          body.scheduled_at = parseLocalDatetime(opts.datetime);
        } catch (err) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
          process.exit(1);
        }
      }
      if (opts.repeat) body.repeat_interval = opts.repeat;
      if (opts.clear_repeat) body.repeat_interval = null;
      if (opts.repeat_stop_date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.repeat_stop_date)) {
          console.error("Error: --repeat_stop_date must be YYYY-MM-DD");
          process.exit(1);
        }
        body.repeat_stop_date = opts.repeat_stop_date;
      }
      if (opts.clear_repeat_stop_date) body.repeat_stop_date = null;

      if (Object.keys(body).length === 0) {
        console.error(
          "Error: no fields to update — pass at least one of --event_title, --description, --clear_description, --datetime, --repeat, --clear_repeat, --repeat_stop_date, --clear_repeat_stop_date"
        );
        process.exit(1);
      }

      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(
        command,
        agentId
      );
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const updated = await client.patchJSON<CalendarEventResponse>(
          `/api/calendar/${opts.event_id}`,
          body
        );
        if (updated.agent_id !== agentId) {
          console.error(
            `Error: event ${updated.id} does not belong to agent ${agentId}`
          );
          process.exit(1);
        }
        if (opts.json) {
          printJSON(updated);
          return;
        }
        printEventDetail(updated);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("delete")
    .description("Delete a calendar event")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--event_id <id>", "Event ID")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(
        command,
        agentId
      );
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        await client.deleteJSON(`/api/calendar/${opts.event_id}`);
        console.log(`Deleted ${opts.event_id}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  return cmd;
}
