import { describe, it, expect } from "vitest";
import { calendarCommand } from "./calendar";

describe("calendarCommand", () => {
  const cmd = calendarCommand();

  it("registers set, list, show, update, and delete subcommands", () => {
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain("set");
    expect(names).toContain("list");
    expect(names).toContain("show");
    expect(names).toContain("update");
    expect(names).toContain("delete");
  });

  it("calendar set requires --event_title, --datetime; --agent_id is optional (env fallback)", () => {
    const set = cmd.commands.find((c) => c.name() === "set")!;
    const opts = (set as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--event_title");
    expect(mandatory).toContain("--datetime");
    // not mandatory
    expect(mandatory).not.toContain("--repeat");
    expect(mandatory).not.toContain("--repeat_stop_date");
  });

  it("calendar set accepts --repeat and --repeat_stop_date as optional", () => {
    const set = cmd.commands.find((c) => c.name() === "set")!;
    const opts = (set as unknown as { options: { long: string }[] }).options;
    const longs = opts.map((o) => o.long);
    expect(longs).toContain("--repeat");
    expect(longs).toContain("--repeat_stop_date");
  });

  it("calendar set accepts --description as optional", () => {
    const set = cmd.commands.find((c) => c.name() === "set")!;
    const opts = (set as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const descOpt = opts.find((o) => o.long === "--description");
    expect(descOpt).toBeDefined();
    expect(descOpt?.mandatory).not.toBe(true);
  });

  it("calendar list has optional --agent_id (env fallback); supports --future_days and --past_days", () => {
    const list = cmd.commands.find((c) => c.name() === "list")!;
    const opts = (list as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    const longs = opts.map((o) => o.long);
    expect(longs).toContain("--agent_id");
    expect(longs).toContain("--future_days");
    expect(longs).toContain("--past_days");
  });

  it("calendar show requires --event_id; --agent_id is optional (env fallback)", () => {
    const show = cmd.commands.find((c) => c.name() === "show")!;
    const opts = (show as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--event_id");
  });

  it("calendar update requires --event_id; --agent_id is optional (env fallback); accepts mutating flags", () => {
    const update = cmd.commands.find((c) => c.name() === "update")!;
    const opts = (update as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--event_id");
    const longs = opts.map((o) => o.long);
    for (const flag of [
      "--event_title",
      "--description",
      "--clear_description",
      "--datetime",
      "--repeat",
      "--clear_repeat",
      "--repeat_stop_date",
      "--clear_repeat_stop_date",
    ]) {
      expect(longs).toContain(flag);
      expect(mandatory).not.toContain(flag);
    }
  });

  it("calendar delete requires --event_id; --agent_id is optional (env fallback)", () => {
    const del = cmd.commands.find((c) => c.name() === "delete")!;
    const opts = (del as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--event_id");
  });

  it("no subcommand accepts --workspace (agent-scoped only)", () => {
    for (const sub of cmd.commands) {
      const opts = (sub as unknown as { options: { long: string }[] }).options;
      const longs = opts.map((o) => o.long);
      expect(longs).not.toContain("--workspace");
    }
  });
});
