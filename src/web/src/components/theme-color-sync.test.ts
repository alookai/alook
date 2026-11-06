import { describe, expect, it, vi } from "vitest";
import { syncThemeColorToVisibleBackground } from "./theme-color-sync";

function fakeStyle(backgroundColor: string) {
  return { backgroundColor } as CSSStyleDeclaration;
}

describe("syncThemeColorToVisibleBackground", () => {
  it("notifies native chrome once when the painted surface changes", () => {
    const dispatchEvent = vi.fn()
    const meta = { content: "previous" }
    const doc = { body: {}, defaultView: { dispatchEvent }, querySelectorAll: () => [meta] } as unknown as Document
    syncThemeColorToVisibleBackground(doc, () => fakeStyle("rgb(224, 213, 192)"))
    syncThemeColorToVisibleBackground(doc, () => fakeStyle("rgb(224, 213, 192)"))
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0].type).toBe("alook:theme-color-change")
    syncThemeColorToVisibleBackground(doc, () => fakeStyle("rgb(5, 5, 5)"))
    expect(dispatchEvent).toHaveBeenCalledTimes(2)
    expect(meta.content).toBe("rgb(5, 5, 5)")
  })
  it("updates every theme-color meta to the computed document backdrop", () => {
    const metas = [{ content: "light" }, { content: "dark" }];
    const doc = {
      body: {},
      querySelectorAll: vi.fn(() => metas),
    } as unknown as Document;

    syncThemeColorToVisibleBackground(
      doc,
      () => fakeStyle("rgb(245, 242, 236)"),
    );

    expect(metas.map((meta) => meta.content)).toEqual([
      "rgb(245, 242, 236)",
      "rgb(245, 242, 236)",
    ]);
  });

  it("does not rewrite metadata that is already synchronized", () => {
    const setContent = vi.fn();
    const meta = {
      get content() {
        return "rgb(245, 242, 236)";
      },
      set content(value: string) {
        setContent(value);
      },
    };
    const doc = {
      body: {},
      querySelectorAll: vi.fn(() => [meta]),
    } as unknown as Document;

    syncThemeColorToVisibleBackground(
      doc,
      () => fakeStyle("rgb(245, 242, 236)"),
    );

    expect(setContent).not.toHaveBeenCalled();
  });

  it("creates a theme-color meta when the document has none", () => {
    const createdMeta = { name: "", content: "" };
    const appendChild = vi.fn();
    const doc = {
      body: {},
      head: { appendChild },
      querySelectorAll: vi.fn(() => []),
      createElement: vi.fn(() => createdMeta),
    } as unknown as Document;

    syncThemeColorToVisibleBackground(
      doc,
      () => fakeStyle("rgb(40, 39, 37)"),
    );

    expect(createdMeta).toEqual({
      name: "theme-color",
      content: "rgb(40, 39, 37)",
    });
    expect(appendChild).toHaveBeenCalledWith(createdMeta);
  });

  it.each(["", "transparent", "rgba(0, 0, 0, 0)"])(
    "keeps the fallback when the computed background is %j",
    (backgroundColor) => {
      const meta = { content: "fallback" };
      const doc = {
        body: {},
        querySelectorAll: vi.fn(() => [meta]),
      } as unknown as Document;

      syncThemeColorToVisibleBackground(doc, () => fakeStyle(backgroundColor));

      expect(meta.content).toBe("fallback");
    },
  );
});
