import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, pointer, click, frame, action, zoom } = demoMotion(root, complete);
  for (const index of [1, 3]) {
    timeline.set(frames[index].querySelector("[data-name]"), { clipPath: "inset(0 100% 0 0)" });
    timeline.set(frames[index].querySelector("[data-name-placeholder]"), { autoAlpha: 1 });
    timeline.set(frames[index].querySelectorAll("[data-machine], [data-option]"), { attr: { "data-selected": "false" } });
  }
  const fill = (index: number, runtime: string, start: number) => {
    const form = frames[index];
    action(`name-${runtime}`, start);
    click(form.querySelector("[data-name-field]")!, start);
    timeline.set(form.querySelector("[data-name-placeholder]"), { autoAlpha: 0 }, start + 0.8)
      .to(form.querySelector("[data-name]"), { clipPath: "inset(0 0% 0 0)", duration: 0.8, ease: "steps(4)" }, start + 0.8);
    action(`machine-${runtime}`, start + 2);
    click(form.querySelector("[data-machine]")!, start + 2);
    timeline.set(form.querySelector("[data-machine]"), { attr: { "data-selected": "true" } }, start + 2.65);
    action(`runtime-${runtime}`, start + 3.5);
    click(form.querySelector(`[data-option="${runtime}"]`)!, start + 3.5);
    timeline.set(form.querySelector(`[data-option="${runtime}"]`), { attr: { "data-selected": "true" } }, start + 4.15);
    action(`create-${runtime}`, start + 5.2);
    click(form.querySelector("[data-create-submit]")!, start + 5.2);
  };
  action("open-create-codex", 0);
  zoom(0, 0.2);
  click(frames[0].querySelector("[data-bot-entry]")!, 1.0);
  frame(0, 1, 1.9);
  fill(1, "codex", 2.3);
  frame(1, 2, 8.8);
  action("codex-created", 8.8);
  zoom(2, 9.5);
  click(frames[2].querySelector("[data-bot-entry]")!, 10.3);
  frame(2, 3, 11.3);
  fill(3, "claude", 11.9);
  frame(3, 4, 18.4);
  action("both-created", 18.4);
  timeline.to(pointer, { autoAlpha: 0, duration: 0.2 }, 18.4).to({}, { duration: 2.5 }, 18.6);
  return timeline;
}
