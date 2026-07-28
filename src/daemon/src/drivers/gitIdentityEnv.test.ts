import { describe, it, expect } from "vitest";
import { buildGitIdentityEnv } from "./gitIdentityEnv";

describe("buildGitIdentityEnv", () => {
  it("normal identity — name#disc, unique email, author===committer", () => {
    const env = buildGitIdentityEnv({ agentName: "Melisa", discriminator: "1043", agentId: "a3f90c21beef" });
    expect(env.GIT_AUTHOR_NAME).toBe("Melisa#1043");
    expect(env.GIT_AUTHOR_EMAIL).toBe("melisa-1043-a3f90c21@alook.ai");
    expect(env.GIT_COMMITTER_NAME).toBe(env.GIT_AUTHOR_NAME);
    expect(env.GIT_COMMITTER_EMAIL).toBe(env.GIT_AUTHOR_EMAIL);
  });

  it("name with spaces/punct — email local-part is ASCII-slugged, display name kept", () => {
    const env = buildGitIdentityEnv({ agentName: "Bot One!", discriminator: "0007", agentId: "zzzz1111" });
    expect(env.GIT_AUTHOR_NAME).toBe("Bot One!#0007");
    expect(env.GIT_AUTHOR_EMAIL).toBe("bot-one-0007-zzzz1111@alook.ai");
  });

  it("CJK/emoji name — empty ASCII slug is dropped, email falls back to disc+shortid, display keeps UTF-8", () => {
    const env = buildGitIdentityEnv({ agentName: "总部🎉", discriminator: "1043", agentId: "a3f90c21beef" });
    expect(env.GIT_AUTHOR_NAME).toBe("总部🎉#1043");
    expect(env.GIT_AUTHOR_EMAIL).toBe("1043-a3f90c21@alook.ai");
  });

  it("strips control chars / newlines from the name (guards commit-metadata injection)", () => {
    const env = buildGitIdentityEnv({
      agentName: "Evil\r\nBot\x00 X",
      discriminator: "1234",
      agentId: "deadbeef00",
    });
    // Control chars removed; the surviving space between "Bot" and "X" stays.
    expect(env.GIT_AUTHOR_NAME).toBe("EvilBot X#1234");
    expect(env.GIT_AUTHOR_NAME).not.toMatch(/[\n\r\x00]/);
  });

  it("missing identity — falls back to a valid generic identity, never empty", () => {
    const env = buildGitIdentityEnv({});
    expect(env.GIT_AUTHOR_NAME).toBe("Alook Agent");
    expect(env.GIT_AUTHOR_EMAIL).toBe("alook-agent@alook.ai");
    for (const v of Object.values(env)) expect(v).not.toBe("");
  });

  it("UNIQUENESS — same name AND same discriminator but different agentId ⇒ DIFFERENT emails", () => {
    const a = buildGitIdentityEnv({ agentName: "Twin", discriminator: "1043", agentId: "aaaaaaaa1111" });
    const b = buildGitIdentityEnv({ agentName: "Twin", discriminator: "1043", agentId: "bbbbbbbb2222" });
    expect(a.GIT_AUTHOR_NAME).toBe(b.GIT_AUTHOR_NAME); // display collides — that's fine
    expect(a.GIT_AUTHOR_EMAIL).not.toBe(b.GIT_AUTHOR_EMAIL); // machine-readable key must not
    expect(a.GIT_AUTHOR_EMAIL).toBe("twin-1043-aaaaaaaa@alook.ai");
    expect(b.GIT_AUTHOR_EMAIL).toBe("twin-1043-bbbbbbbb@alook.ai");
  });

  it("agentId is ASCII-slugged before slicing (nanoid '_'/'-' stay email-safe)", () => {
    const env = buildGitIdentityEnv({ agentName: "X", discriminator: "0001", agentId: "Ab_9-Cd_ef" });
    // local-part contains only [a-z0-9-]; no stray underscores from the id.
    expect(env.GIT_AUTHOR_EMAIL).toMatch(/^[a-z0-9-]+@alook\.ai$/);
  });
});
