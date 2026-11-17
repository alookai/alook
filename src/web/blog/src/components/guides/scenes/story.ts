import { gsap } from "gsap";
import { demoMotion } from "./motion";
import type { StoryStep } from "../story-demo";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, action, frame } = demoMotion(root, complete);
  const list = root.querySelector<HTMLElement>("[data-story-list]");
  const stage = root.querySelector<HTMLElement>("[data-story-thread]")!;
  const threadIndex = [...frames].indexOf(stage);
  const channel = stage.querySelector<HTMLElement>("[data-story-channel]")!;
  const steps = JSON.parse(channel.dataset.storySteps ?? "[]") as StoryStep[];
  const editor = stage.querySelector("[data-tutorial-editor]")!;
  const update = (detail: object) => channel.dispatchEvent(new CustomEvent("story-state", { detail }));
  const slot = (index: number) => () => stage.querySelector(`[data-story-message="${index}"]`) ?? editor;
  const camera = (at: number, target: (() => Element) | null, view: HTMLElement = stage) => {
    // GSAP resolves function values when the tween initialises, before onStart fires, so the
    // destination is measured inside the value getters at that moment, not in onStart.
    let destination: { scale: number; x: number; y: number } | null = null;
    const measure = () => {
      if (destination) return destination;
      if (!target) return (destination = { scale: 1, x: 0, y: 0 });
      const current = { scale: Number(gsap.getProperty(view, "scale")), x: Number(gsap.getProperty(view, "x")), y: Number(gsap.getProperty(view, "y")) };
      const base = root.getBoundingClientRect(), element = target(), rect = element.getBoundingClientRect();
      // On phones, fit the whole conversation column (or the target's own view) to the frame width so
      // rows are never cut at the left or right edge; zoom no further than that.
      const column = (element.closest("[data-story-channel], [data-story-forum], [data-story-machine-list]") ?? element).getBoundingClientRect();
      const columnLeft = (column.left - base.left - current.x) / current.scale, columnWidth = column.width / current.scale;
      // Desktop frames are wide enough to read the whole shell; only narrow (phone) frames zoom.
      const scale = base.width >= 600 ? 1 : Math.max(1, Math.min(2.6, base.width / columnWidth));
      const fy = (rect.top - base.top - current.y + Math.min(rect.height, base.height * 0.5) / 2) / current.scale;
      return (destination = { scale, x: Math.max(base.width * (1 - scale), Math.min(0, -columnLeft * scale)), y: Math.max(base.height * (1 - scale), Math.min(0, base.height * 0.5 - fy * scale)) });
    };
    timeline.to(view, { duration: 0.9, ease: "power2.inOut", immediateRender: false, scale: () => measure().scale, x: () => measure().x, y: () => measure().y }, at);
  };
  gsap.set(frames, { transformOrigin: "top left" });
  timeline.call(() => update({ shown: 0, typing: null, mentions: 0, text: "", popup: -1 }), [], 0);
  let at = 0.6;
  const machines = root.querySelector<HTMLElement>("[data-story-machines]");
  if (machines) {
    const listView = () => machines.querySelector("[data-story-machine-list]") ?? machines;
    action("machines-online", at);
    camera(at + 0.4, listView, machines);
    move(listView, at + 1.2);
    camera(at + 3.2, null, machines);
    frame([...frames].indexOf(machines), list ? [...frames].indexOf(list) : threadIndex, at + 3.6);
    at += 4.2;
  }
  if (list) {
    const forum = list.querySelector<HTMLElement>("[data-story-forum]")!;
    const card = () => list.querySelector('[data-testid="community-forum-post-story-post-0"]') ?? forum;
    timeline.call(() => forum.dispatchEvent(new CustomEvent("story-state", { detail: { posted: false } })), [], 0);
    action("post-created", at + 0.4);
    timeline.call(() => forum.dispatchEvent(new CustomEvent("story-state", { detail: { posted: true } })), [], at + 0.4);
    camera(at + 0.8, card, list);
    click(card, at + 1.8);
    camera(at + 3, null, list);
    frame([...frames].indexOf(list), threadIndex, at + 3);
    at += 3.6;
  }
  for (const [index, step] of steps.entries()) {
    if ("send" in step) {
      action(`send-${index}`, at);
      camera(at, () => editor);
      click(editor, at + 1);
      at += 2.1;
      for (const [mention, name] of (step.mentions ?? []).entries()) {
        for (const [count, text] of ["@", `@${name.slice(0, 1)}`, `@${name.slice(0, 2)}`].entries()) timeline.call(() => update({ text }), [], at + count * 0.2);
        timeline.call(() => update({ popup: mention }), [], at + 0.7);
        click(() => stage.querySelector(`[data-mention-choice="${mention}"]`) ?? editor, at + 0.8);
        timeline.call(() => update({ mentions: mention + 1, text: "", popup: -1 }), [], at + 2);
        at += 2.3;
      }
      const speed = Math.min(0.05, 2.6 / Math.max(step.text.length, 1));
      for (let count = 1; count <= step.text.length; count++) timeline.call(() => update({ text: step.text.slice(0, count) }), [], at + count * speed);
      at += step.text.length * speed + 0.4;
      click(() => stage.querySelector('[data-message-composer] [aria-label="Send message"]') ?? editor, at);
      timeline.call(() => update({ shown: index + 1, mentions: 0, text: "" }), [], at + 1.1);
      at += 1.5;
    } else {
      action(`post-${index}`, at);
      timeline.call(() => update({ typing: step.post }), [], at);
      timeline.call(() => update({ typing: null, shown: index + 1 }), [], at + 1.2);
      at += 1.4;
    }
    camera(at, slot(index));
    move(slot(index), at + 1);
    at += 2 + Math.min(2.5, step.text.length / 80);
  }
  camera(at, null);
  timeline.to({}, { duration: 3 }, at + 1);
  return timeline;
}
