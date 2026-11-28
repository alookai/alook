import { describe, expect, it } from "vitest"
import {
  buildOpenArtifactHostHello,
  isSafeExternalHttpUrl,
  normalizeAllowedOrigin,
  normalizeAllowedOrigins,
  OPEN_ARTIFACT_HOST_PROTOCOL,
  parseTrustedShellMessage,
  verifyOpenArtifactEmbedUrl,
} from "./open-artifact-policy"

describe("open-artifact-policy", () => {
  it("normalizes exact http/https origins and rejects wildcards, paths, or credentials", () => {
    expect(normalizeAllowedOrigin("https://oa.alook.ai")).toBe("https://oa.alook.ai")
    expect(normalizeAllowedOrigin("http://127.0.0.1:8788/")).toBe("http://127.0.0.1:8788")
    expect(normalizeAllowedOrigin("https://*.alook.ai")).toBeNull()
    expect(normalizeAllowedOrigin("*")).toBeNull()
    expect(normalizeAllowedOrigin("https://oa.alook.ai/path")).toBeNull()
    expect(normalizeAllowedOrigin("https://user:pass@oa.alook.ai")).toBeNull()
    expect(normalizeAllowedOrigin("javascript:alert(1)")).toBeNull()
    expect(normalizeAllowedOrigins(["https://oa.alook.ai/", "https://oa.alook.ai", "*"]))
      .toEqual(["https://oa.alook.ai"])
  })

  it("verifies embed URLs strictly against the exact allowlist", () => {
    const allowed = ["https://oa.alook.ai", "http://localhost:8788"]

    expect(verifyOpenArtifactEmbedUrl("https://oa.alook.ai/a/doc_1?token=abc", allowed)).toEqual({
      ok: true,
      url: "https://oa.alook.ai/a/doc_1?token=abc",
      origin: "https://oa.alook.ai",
    })
    expect(verifyOpenArtifactEmbedUrl("http://localhost:8788/a/doc_1", allowed)).toEqual({
      ok: true,
      url: "http://localhost:8788/a/doc_1",
      origin: "http://localhost:8788",
    })

    expect(verifyOpenArtifactEmbedUrl("https://evil.example/a/doc_1", allowed)).toEqual({
      ok: false,
      reason: "untrusted-origin",
    })
    expect(verifyOpenArtifactEmbedUrl("https://oa.alook.ai.evil.example/a/doc_1", allowed)).toEqual({
      ok: false,
      reason: "untrusted-origin",
    })
    expect(verifyOpenArtifactEmbedUrl("javascript:alert(1)", allowed)).toEqual({
      ok: false,
      reason: "invalid-url",
    })
    expect(verifyOpenArtifactEmbedUrl("data:text/html,<h1>hi</h1>", allowed)).toEqual({
      ok: false,
      reason: "invalid-url",
    })
    expect(verifyOpenArtifactEmbedUrl("https://user@oa.alook.ai/a/doc_1", allowed)).toEqual({
      ok: false,
      reason: "invalid-url",
    })
    expect(verifyOpenArtifactEmbedUrl("https://oa.alook.ai/a/doc_1", [])).toEqual({
      ok: false,
      reason: "untrusted-origin",
    })
  })

  it("builds upstream host_hello payloads with toolbar, switcher, and theme scheme", () => {
    expect(buildOpenArtifactHostHello("dark")).toEqual({
      openArtifact: "host_hello",
      protocol: OPEN_ARTIFACT_HOST_PROTOCOL,
      caps: { toolbar: true, switcher: true },
      theme: { scheme: "dark" },
    })
    expect(buildOpenArtifactHostHello("light")).toEqual({
      openArtifact: "host_hello",
      protocol: OPEN_ARTIFACT_HOST_PROTOCOL,
      caps: { toolbar: true, switcher: true },
      theme: { scheme: "light" },
    })
  })

  it("parses Shell-to-Host messages only from the exact verified origin and frame window", () => {
    const frameWindow = {} as MessageEventSource
    const otherWindow = {} as MessageEventSource
    const origin = "https://oa.alook.ai"

    expect(parseTrustedShellMessage(
      {
        origin,
        source: frameWindow,
        data: { openArtifact: "shell_hello", version: "1.0.0", protocol: 1, artifact: "open-artifact://artifact/p1", id: "p1", title: "Roadmap", type: "doc" },
      },
      origin,
      frameWindow,
    )).toEqual({
      openArtifact: "shell_hello",
      version: "1.0.0",
      protocol: 1,
      artifact: "open-artifact://artifact/p1",
      id: "p1",
      title: "Roadmap",
      type: "doc",
    })

    expect(parseTrustedShellMessage(
      { origin, source: frameWindow, data: { openArtifact: "saved", state: "unsaved", leaveLosesWork: true } },
      origin,
      frameWindow,
    )).toEqual({ openArtifact: "saved", state: "unsaved", leaveLosesWork: true })

    expect(parseTrustedShellMessage(
      { origin, source: frameWindow, data: { openArtifact: "place", artifact: "p1", hash: "#slide-2" } },
      origin,
      frameWindow,
    )).toEqual({ openArtifact: "place", artifact: "p1", hash: "#slide-2" })

    expect(parseTrustedShellMessage(
      { origin, source: frameWindow, data: { openArtifact: "open_external", url: "javascript:alert(1)" } },
      origin,
      frameWindow,
    )).toBeNull()

    expect(parseTrustedShellMessage(
      { origin: "https://evil.example", source: frameWindow, data: { openArtifact: "shell_ready", artifact: "p1" } },
      origin,
      frameWindow,
    )).toBeNull()

    expect(parseTrustedShellMessage(
      { origin, source: otherWindow, data: { openArtifact: "shell_ready", artifact: "p1" } },
      origin,
      frameWindow,
    )).toBeNull()

    expect(isSafeExternalHttpUrl("https://alook.ai/docs")).toBe("https://alook.ai/docs")
    expect(isSafeExternalHttpUrl("javascript:void(0)")).toBeNull()
  })
})
