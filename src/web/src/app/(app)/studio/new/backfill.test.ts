import { describe, it, expect } from "vitest";

type Member = { uid: string; name: string; emailHandle?: string };

function backfill(members: Member[], handles: { uid: string; handle: string }[]): Member[] {
  return members.map((m) => {
    const h = handles.find((h) => h.uid === m.uid);
    return h ? { ...m, emailHandle: h.handle } : m;
  });
}

describe("studio handle backfill by uid", () => {
  it("maps each same-name member to its own uid's handle without crossing", () => {
    const members: Member[] = [
      { uid: "a", name: "Ada" },
      { uid: "b", name: "Ada" },
    ];
    const handles = [
      { uid: "a", handle: "ada" },
      { uid: "b", handle: "ada-blue" },
    ];

    const result = backfill(members, handles);

    expect(result[0].emailHandle).toBe("ada");
    expect(result[1].emailHandle).toBe("ada-blue");
  });

  it("does not cross when response order differs from member order", () => {
    const members: Member[] = [
      { uid: "a", name: "Ada" },
      { uid: "b", name: "Ada" },
    ];
    const handles = [
      { uid: "b", handle: "ada-blue" },
      { uid: "a", handle: "ada" },
    ];

    const result = backfill(members, handles);

    expect(result[0].emailHandle).toBe("ada");
    expect(result[1].emailHandle).toBe("ada-blue");
  });

  it("leaves emailHandle unset for members with no matching uid", () => {
    const members: Member[] = [{ uid: "a", name: "Ada" }];
    const result = backfill(members, [{ uid: "z", handle: "zed" }]);
    expect(result[0].emailHandle).toBeUndefined();
  });
});
