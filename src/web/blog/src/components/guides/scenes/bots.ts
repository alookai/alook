import { requiresExplicitModel } from "@alook/shared";
import { tutorialModel } from "../mock-scenes";
import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, frame, action, zoom } = demoMotion(root, complete);
  const update = (index: number, detail: object) => frames[index].querySelector("[data-bot-form]")!.dispatchEvent(new CustomEvent("tutorial-form", { detail }));
  const { botRuntime: runtime, botName: name, initialRuntime } = root.querySelector<HTMLElement>("[data-bot-runtime]")!.dataset as { botRuntime: string; botName: string; initialRuntime: string };
  timeline.call(() => update(1, { name: "", runtime: initialRuntime, model: null, modelOpen: false }), [], 0);
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
    const modelTime = requiresExplicitModel(runtime) ? 7 : 0;
    if (modelTime) {
      const body = form.querySelector<HTMLElement>('[data-slot="sheet-body"]')!;
      timeline.set(body, { scrollTop: 0 }, 0);
      timeline.to(body, { scrollTop: () => body.scrollHeight - body.clientHeight, duration: 0.6, ease: "power2.inOut" }, start + 5.9);
      const modelTrigger = form.querySelector('[data-testid="bot-model-select"]')!;
      const modelOption = () => Array.from(form.querySelectorAll('[data-model-menu] [role="option"]')).find(option => option.textContent?.includes(tutorialModel))!;
      zoom(index, start + 6.6, modelTrigger);
      action("choose-model", start + 7.6);
      click(modelTrigger, start + 7.6);
      timeline.call(() => update(index, { modelOpen: true }), [], start + 8.7);
      zoom(index, start + 9, () => form.querySelector('[data-model-menu] [data-slot="select-content"]')!);
      click(modelOption, start + 10.4);
      timeline.call(() => update(index, { model: tutorialModel, modelOpen: false }), [], start + 11.6);
    }
    zoom(index, start + 6.6 + modelTime, submit);
    action(`create-${runtime}`, start + 7.6 + modelTime);
    click(submit, start + 7.6 + modelTime);
  };
  const entry = frames[0].querySelector("[data-bot-entry]")!;
  action(`open-create-${runtime}`, 0);
  move(entry, 0.4);
  zoom(0, 1.5, entry);
  click(entry, 2.4);
  frame(0, 1, 3.8);
  fill(1, runtime, name, 4.3);
  const modelTime = requiresExplicitModel(runtime) ? 7 : 0;
  frame(1, 2, 13.6 + modelTime);
  action(`${runtime}-created`, 13.6 + modelTime);
  timeline.to({}, { duration: 3 }, 13.8 + modelTime);
  return timeline;
}
