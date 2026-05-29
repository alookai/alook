import { describe, it, expect } from "vitest";
import { GET } from "./route";

function makeRequest(id: string) {
  return GET(
    new Request(`http://localhost/templates/${id}/json`),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /templates/[id]/json", () => {
  it("returns 200 with correct JSON structure for valid template", async () => {
    const res = await makeRequest("open-source-maintainer");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = await res.json();
    expect(data.name).toBe("Open Source Maintainer");
    expect(data.scenario).toBe("software-dev");
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 404 JSON for nonexistent template slug", async () => {
    const res = await makeRequest("does-not-exist");
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe("Template not found");
  });

  it("does not include name field in member objects", async () => {
    const res = await makeRequest("open-source-maintainer");
    const data = await res.json();

    for (const member of data.members) {
      expect(member).not.toHaveProperty("name");
    }
  });

  it("leader member has no relationship, specialists have relationship", async () => {
    const res = await makeRequest("open-source-maintainer");
    const data = await res.json();

    const leader = data.members.find((m: { role: string }) => m.role === "leader");
    expect(leader).toBeTruthy();
    expect(leader).not.toHaveProperty("relationship");

    const specialists = data.members.filter((m: { role: string }) => m.role !== "leader");
    expect(specialists.length).toBeGreaterThanOrEqual(1);
    for (const spec of specialists) {
      expect(spec.relationship).toBeTruthy();
      expect(spec.relationship.leaderSees).toBeTruthy();
      expect(spec.relationship.memberSees).toBeTruthy();
    }
  });

  it("includes instructions for all members", async () => {
    const res = await makeRequest("open-source-maintainer");
    const data = await res.json();

    for (const member of data.members) {
      expect(member.instructions).toBeTruthy();
      expect(typeof member.instructions).toBe("string");
      expect(member.instructions.length).toBeGreaterThan(10);
    }
  });
});
