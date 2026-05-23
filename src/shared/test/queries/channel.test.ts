import { describe, it, expect } from "vitest";
import * as channelQueries from "../../src/db/queries/channel";

describe("channel query module exports", () => {
  it("exports createChannel", () => {
    expect(typeof channelQueries.createChannel).toBe("function");
  });

  it("exports listChannels", () => {
    expect(typeof channelQueries.listChannels).toBe("function");
  });

  it("exports getChannelByName", () => {
    expect(typeof channelQueries.getChannelByName).toBe("function");
  });

  it("exports getChannelById", () => {
    expect(typeof channelQueries.getChannelById).toBe("function");
  });

  it("exports deleteChannel", () => {
    expect(typeof channelQueries.deleteChannel).toBe("function");
  });

  it("exports renameChannel", () => {
    expect(typeof channelQueries.renameChannel).toBe("function");
  });

  it("exports reorderChannels", () => {
    expect(typeof channelQueries.reorderChannels).toBe("function");
  });
});

describe("channel query function signatures", () => {
  it("createChannel accepts (db, data)", () => {
    expect(channelQueries.createChannel.length).toBe(2);
  });

  it("listChannels accepts (db, workspaceId)", () => {
    expect(channelQueries.listChannels.length).toBe(2);
  });

  it("getChannelByName accepts (db, workspaceId, name)", () => {
    expect(channelQueries.getChannelByName.length).toBe(3);
  });

  it("getChannelById accepts (db, id, workspaceId)", () => {
    expect(channelQueries.getChannelById.length).toBe(3);
  });

  it("deleteChannel accepts (db, id, workspaceId)", () => {
    expect(channelQueries.deleteChannel.length).toBe(3);
  });

  it("renameChannel accepts (db, id, workspaceId, newName)", () => {
    expect(channelQueries.renameChannel.length).toBe(4);
  });

  it("reorderChannels accepts (db, workspaceId, orderedChannelIds)", () => {
    expect(channelQueries.reorderChannels.length).toBe(3);
  });
});
