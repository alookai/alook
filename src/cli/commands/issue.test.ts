import { describe, expect, it } from "vitest";
import { issueCommand } from "./issue";

describe("issueCommand", () => {
  const cmd = issueCommand();

  it("registers issue subcommands", () => {
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain("create");
    expect(names).toContain("list");
    expect(names).toContain("pull");
    expect(names).toContain("show");
    expect(names).toContain("update");
    expect(names).toContain("comment");
  });

  it("create requires agent_id and title", () => {
    const create = cmd.commands.find((c) => c.name() === "create")!;
    const opts = (create as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).toContain("--agent_id");
    expect(mandatory).toContain("--title");
  });

  it("show/update/comment require agent_id and issue_id", () => {
    for (const name of ["show", "update", "comment"]) {
      const sub = cmd.commands.find((c) => c.name() === name)!;
      const opts = (sub as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
      const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
      expect(mandatory).toContain("--agent_id");
      expect(mandatory).toContain("--issue_id");
    }
  });

  it("update supports status, title, description, and body-file", () => {
    const update = cmd.commands.find((c) => c.name() === "update")!;
    const opts = (update as unknown as { options: { long: string }[] }).options;
    const longs = opts.map((o) => o.long);
    expect(longs).toContain("--status");
    expect(longs).toContain("--title");
    expect(longs).toContain("--description");
    expect(longs).toContain("--body-file");
  });
});
