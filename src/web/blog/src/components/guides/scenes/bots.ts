import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, frame, action, zoom } = demoMotion(root, complete);
  const update = (index: number, detail: object) => frames[index].querySelector("[data-bot-form]")!.dispatchEvent(new CustomEvent("tutorial-form", { detail }));
  timeline.call(() => { update(1, { name: "", runtime: "codex" }); update(3, { name: "", runtime: "codex" }); }, [], 0);
  const fill = (index: number, runtime: string, name: string, start: number) => {
    const form = frames[index];
    const nameField = form.querySelector("[data-name-field]")!;
    const option = form.querySelector(`[data-motion-target="tutorial-runtime-${runtime}"]`)!;
    const submit = form.querySelector("[data-create-submit]")!;
    zoom(index, start, nameField);
    action(`name-${runtime}`, start + 1);
    click(nameField, start + 1);
    for (let count = 1; count <= name.length; count++) timeline.call(() => update(index, { name: name.slice(0, count) }), [], start + 2.3 + count * 0.18);
    zoom(index, start + 3.5, option);
    action(`runtime-${runtime}`, start + 4.5);
    click(option, start + 4.5);
    timeline.call(() => update(index, { runtime }), [], start + 5.6);
    zoom(index, start + 6.6, submit);
    action(`create-${runtime}`, start + 7.6);
    click(submit, start + 7.6);
  };
  const entry = frames[0].querySelector("[data-bot-entry]")!;
  action("open-create-codex", 0);
  move(entry, 0.4);
  zoom(0, 1.5, entry);
  click(entry, 2.4);
  frame(0, 1, 3.8);
  fill(1, "codex", "Milo", 4.3);
  frame(1, 2, 13.6);
  action("codex-created", 13.6);
  const nextEntry = frames[2].querySelector("[data-bot-entry]")!;
  move(nextEntry, 15);
  zoom(2, 16.2, nextEntry);
  click(nextEntry, 17.2);
  frame(2, 3, 18.6);
  fill(3, "claude", "Nova", 19.1);
  frame(3, 4, 28.5);
  action("both-created", 28.5);
  timeline.to({}, { duration: 3 }, 28.8);
  return timeline;
}
