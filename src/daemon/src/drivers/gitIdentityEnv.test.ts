import { describe, it, expect } from "vitest";
import { buildGitIdentityEnv } from "./gitIdentityEnv";

describe("buildGitIdentityEnv", () => {
  it("normal identity — plain name, name.disc@alook.ai email, author===committer", () => {
    const env = buildGitIdentityEnv({ agentName: "Claudette", discriminator: "9873" });
    expect(env.GIT_AUTHOR_NAME).toBe("Claudette");
    expect(env.GIT_AUTHOR_EMAIL).toBe("claudette.9873@alook.ai");
    expect(env.GIT_COMMITTER_NAME).toBe(env.GIT_AUTHOR_NAME);
    expect(env.GIT_COMMITTER_EMAIL).toBe(env.GIT_AUTHOR_EMAIL);
  });

  it("name with spaces/punct — email local-part is ASCII-slugged, display name kept plain", () => {
    const env = buildGitIdentityEnv({ agentName: "Bot One!", discriminator: "0007" });
    expect(env.GIT_AUTHOR_NAME).toBe("Bot One!");
    expect(env.GIT_AUTHOR_EMAIL).toBe("bot-one.0007@alook.ai");
  });

  it("CJK/emoji name — empty ASCII slug dropped, email falls back to disc only, display keeps UTF-8", () => {
    const env = buildGitIdentityEnv({ agentName: "总部🎉", discriminator: "1043" });
    expect(env.GIT_AUTHOR_NAME).toBe("总部🎉");
    expect(env.GIT_AUTHOR_EMAIL).toBe("1043@alook.ai");
  });

  it("strips control chars / newlines from the name (guards commit-metadata injection)", () => {
    const env = buildGitIdentityEnv({ agentName: "Evil\r\nBot\x00 X", discriminator: "1234" });
    // Control chars removed; the surviving space between "Bot" and "X" stays.
    expect(env.GIT_AUTHOR_NAME).toBe("EvilBot X");
    expect(env.GIT_AUTHOR_NAME).not.toMatch(/[\n\r\x00]/);
    expect(env.GIT_AUTHOR_EMAIL).toBe("evilbot-x.1234@alook.ai");
  });

  it("missing identity — falls back to a valid generic identity, never empty", () => {
    const env = buildGitIdentityEnv({});
    expect(env.GIT_AUTHOR_NAME).toBe("Alook Agent");
    expect(env.GIT_AUTHOR_EMAIL).toBe("alook-agent@alook.ai");
    for (const v of Object.values(env)) expect(v).not.toBe("");
  });

  it("name present but no discriminator — email local-part is just the name slug", () => {
    const env = buildGitIdentityEnv({ agentName: "Claudette" });
    expect(env.GIT_AUTHOR_NAME).toBe("Claudette");
    expect(env.GIT_AUTHOR_EMAIL).toBe("claudette@alook.ai");
  });

  it("email local-part is always email-safe ([a-z0-9.-])", () => {
    const env = buildGitIdentityEnv({ agentName: "A B_c", discriminator: "0001" });
    expect(env.GIT_AUTHOR_EMAIL).toMatch(/^[a-z0-9.-]+@alook\.ai$/);
  });

  it("same name AND discriminator ⇒ same identity (accepted collision — no agentId suffix)", () => {
    const a = buildGitIdentityEnv({ agentName: "Twin", discriminator: "1043" });
    const b = buildGitIdentityEnv({ agentName: "Twin", discriminator: "1043" });
    expect(a.GIT_AUTHOR_EMAIL).toBe(b.GIT_AUTHOR_EMAIL);
    expect(a.GIT_AUTHOR_EMAIL).toBe("twin.1043@alook.ai");
  });

  it("host user present (name+email) ⇒ AUTHOR = human owner, COMMITTER = agent (two-author split)", () => {
    const env = buildGitIdentityEnv({
      agentName: "Claudette",
      discriminator: "9873",
      hostUser: { name: "Gus", email: "gus@example.com" },
    });
    // Author = the human owner (they wrote it).
    expect(env.GIT_AUTHOR_NAME).toBe("Gus");
    expect(env.GIT_AUTHOR_EMAIL).toBe("gus@example.com");
    // Committer = the agent (it applied it).
    expect(env.GIT_COMMITTER_NAME).toBe("Claudette");
    expect(env.GIT_COMMITTER_EMAIL).toBe("claudette.9873@alook.ai");
  });

  it("host user with only a name (no email) ⇒ not enough to attribute → agent is both", () => {
    const env = buildGitIdentityEnv({
      agentName: "Claudette",
      discriminator: "9873",
      hostUser: { name: "Gus" },
    });
    expect(env.GIT_AUTHOR_NAME).toBe("Claudette");
    expect(env.GIT_AUTHOR_EMAIL).toBe("claudette.9873@alook.ai");
    expect(env.GIT_COMMITTER_NAME).toBe("Claudette");
    expect(env.GIT_COMMITTER_EMAIL).toBe("claudette.9873@alook.ai");
  });

  it("host user with only an email (no name) ⇒ not enough to attribute → agent is both", () => {
    const env = buildGitIdentityEnv({
      agentName: "Claudette",
      discriminator: "9873",
      hostUser: { email: "gus@example.com" },
    });
    expect(env.GIT_AUTHOR_NAME).toBe("Claudette");
    expect(env.GIT_AUTHOR_EMAIL).toBe("claudette.9873@alook.ai");
  });

  it("host user name is control-char/newline sanitized (commit-metadata injection guard)", () => {
    const env = buildGitIdentityEnv({
      agentName: "Claudette",
      discriminator: "9873",
      hostUser: { name: "Real\r\nHuman", email: "h@x.com" },
    });
    expect(env.GIT_AUTHOR_NAME).toBe("RealHuman");
    expect(env.GIT_AUTHOR_NAME).not.toMatch(/[\n\r\x00]/);
    expect(env.GIT_AUTHOR_EMAIL).toBe("h@x.com");
  });

  it("empty-string host name/email ⇒ treated as absent → agent is both", () => {
    const env = buildGitIdentityEnv({
      agentName: "Claudette",
      discriminator: "9873",
      hostUser: { name: "", email: "" },
    });
    expect(env.GIT_AUTHOR_NAME).toBe("Claudette");
    expect(env.GIT_AUTHOR_EMAIL).toBe("claudette.9873@alook.ai");
  });
});
