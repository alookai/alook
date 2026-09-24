import { afterEach, describe, expect, it } from "vitest";
import { communityWriteDb } from "../helpers/community-write-db";
import { listRecentMessagesForDuplicateCheck } from "../../src/db/queries/community/message";

let fixture: ReturnType<typeof communityWriteDb> | undefined;
afterEach(() => fixture?.sqlite.close());

describe("recent duplicate-check messages", () => {
  it("returns only the latest three persisted rows in this channel, including after deletion", async () => {
    fixture = communityWriteDb();
    fixture.sqlite.exec("ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT 'helper'; ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '1234'");
    fixture.sqlite.exec("INSERT INTO community_channel (id, created_at) VALUES ('other', 'now')");
    const insert = fixture.sqlite.prepare("INSERT INTO community_message (id, channel_id, author_id, content, created_at, seq) VALUES (?, ?, 'author', ?, ?, ?)");
    for (let seq = 1; seq <= 5; seq++) {
      insert.run(`m${seq}`, "channel", `body${seq}`, `2026-09-24T12:00:0${seq}Z`, seq);
    }
    insert.run("foreign", "other", "private", "2026-09-24T12:01:00Z", 1);
    fixture.sqlite.exec("DELETE FROM community_message WHERE id = 'm5'");
    const result = await listRecentMessagesForDuplicateCheck(fixture.db, "channel");
    expect(result.map((row) => row.content)).toEqual(["body4", "body3", "body2"]);
    expect(result[0]).toMatchObject({ content: "body4", name: "helper", discriminator: "1234" });
    expect(await listRecentMessagesForDuplicateCheck(fixture.db, "empty")).toEqual([]);
  });

  it("uses deterministic newest ordering for timestamp ties and includes legacy rows", async () => {
    fixture = communityWriteDb();
    fixture.sqlite.exec("ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT 'helper'; ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '1234'");
    const insert = fixture.sqlite.prepare("INSERT INTO community_message (id, content, channel_id, author_id, created_at, seq) VALUES (?, ?, 'channel', 'author', '2026-09-24T12:00:00Z', 0)");
    for (const id of ["a", "c", "b", "d"]) insert.run(id, id);
    expect((await listRecentMessagesForDuplicateCheck(fixture.db, "channel")).map((row) => row.content)).toEqual(["d", "c", "b"]);
  });
});
