import { gsap } from "gsap";

export function demoMotion(root: HTMLElement, complete: () => void) {
  const frames = root.querySelectorAll<HTMLElement>("[data-demo-frame]");
  const pointer = root.querySelector<HTMLElement>("[data-demo-pointer]")!;
  let trackedTarget: Element | null = null;
  const timeline = gsap.timeline({ paused: true, onComplete: complete });
  timeline.call(() => { trackedTarget = null; }, [], 0);
  timeline.set(frames, { autoAlpha: 0, scale: 1, x: 0, y: 0, transformOrigin: "top left" }).set(frames[0], { autoAlpha: 1 }).set(pointer, { autoAlpha: 1, x: 30, y: 90, scale: 1 });
  const resolveTarget = (target: Element | (() => Element)) => typeof target === "function" ? target() : target;
  const move = (target: Element | (() => Element), at: number) => {
    const position = () => {
      const base = root.getBoundingClientRect(), rect = resolveTarget(target).getBoundingClientRect();
      return { x: rect.left - base.left + rect.width / 2, y: rect.top - base.top + rect.height / 2 };
    };
    timeline.to(pointer, { x: () => position().x, y: () => position().y, duration: 0.8, ease: "power2.inOut", onComplete: () => { trackedTarget = resolveTarget(target); } }, at);
  };
  const click = (target: Element | (() => Element), at: number) => {
    move(target, at);
    timeline.to(pointer, { scale: 0.78, duration: 0.12 }, at + 0.9).to(pointer, { scale: 1, duration: 0.18 }, at + 1.02);
  };
  const frame = (from: number, to: number, at: number) => timeline.to(frames[from], { autoAlpha: 0, duration: 0.3 }, at).to(frames[to], { autoAlpha: 1, duration: 0.3 }, at);
  const zoom = (index: number, at: number, target: Element | (() => Element)) => {
    const state = { progress: 0 };
    const camera = { scale: 1, x: 0, y: 0 };
    let destination = camera;
    timeline.to(state, { progress: 1, duration: 0.8, ease: "power2.inOut", onStart: () => {
      const element = resolveTarget(target);
      const base = root.getBoundingClientRect(), rect = element.getBoundingClientRect(), frameRect = frames[index].getBoundingClientRect();
      let scale = Math.min(3, 1120 / base.width);
      camera.scale = Number(gsap.getProperty(frames[index], "scale")); camera.x = Number(gsap.getProperty(frames[index], "x")); camera.y = Number(gsap.getProperty(frames[index], "y"));
      if (element.hasAttribute("data-motion-fit-width")) scale = Math.min(scale, (base.width - 24) / (rect.width / camera.scale));
      const panel = element.closest('[data-slot="sheet-content"], [data-slot="dialog-content"], [data-tutorial-panel]')?.getBoundingClientRect() ?? rect;
      const tx = (panel.left + panel.width / 2 - frameRect.left) / camera.scale;
      const ty = (rect.top + rect.height / 2 - frameRect.top) / camera.scale;
      destination = { scale, x: Math.max(base.width * (1 - scale), Math.min(0, base.width / 2 - tx * scale)), y: frames[index].hasAttribute("data-motion-center-y") ? base.height / 2 - ty * scale : Math.max(base.height * (1 - scale), Math.min(0, base.height / 2 - ty * scale)) };
    }, onUpdate: () => {
      const p = state.progress;
      gsap.set(frames[index], { scale: camera.scale + (destination.scale - camera.scale) * p, x: camera.x + (destination.x - camera.x) * p, y: camera.y + (destination.y - camera.y) * p });
      if (trackedTarget === resolveTarget(target) && frames[index].contains(trackedTarget)) {
        const base = root.getBoundingClientRect(), rect = trackedTarget.getBoundingClientRect();
        gsap.set(pointer, { x: rect.left - base.left + rect.width / 2, y: rect.top - base.top + rect.height / 2 });
      }
    } }, at);
  };
  const action = (name: string, at: number) => timeline.set(root, { attr: { "data-demo-action": name } }, at);
  return { timeline, frames, pointer, move, click, frame, action, zoom };
}
