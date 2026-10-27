import { gsap } from "gsap";

export function demoMotion(root: HTMLElement, complete: () => void) {
  const frames = root.querySelectorAll<HTMLElement>("[data-demo-frame]");
  const pointer = root.querySelector<HTMLElement>("[data-demo-pointer]")!;
  const timeline = gsap.timeline({ paused: true, onComplete: complete });
  timeline.set(frames, { autoAlpha: 0, scale: 1, x: 0, transformOrigin: "65% 45%" }).set(frames[0], { autoAlpha: 1 }).set(pointer, { autoAlpha: 0, x: 24, y: 80, scale: 1 });
  const move = (target: Element, at: number) => {
    const position = () => {
      const base = root.getBoundingClientRect(), rect = target.getBoundingClientRect();
      return { x: rect.left - base.left + rect.width * 0.6, y: rect.top - base.top + rect.height * 0.55 };
    };
    timeline.to(pointer, { autoAlpha: 1, x: () => position().x, y: () => position().y, duration: 0.55, ease: "power2.inOut" }, at);
  };
  const click = (target: Element, at: number) => {
    move(target, at);
    timeline.to(pointer, { scale: 0.7, duration: 0.12 }, at + 0.55).to(pointer, { scale: 1, duration: 0.18 }, at + 0.67);
    timeline.fromTo(target, { filter: "brightness(1)" }, { filter: "brightness(0.85)", duration: 0.12, repeat: 1, yoyo: true }, at + 0.55);
  };
  const frame = (from: number, to: number, at: number) => {
    timeline.to(frames[from], { autoAlpha: 0, duration: 0.2 }, at).to(frames[to], { autoAlpha: 1, duration: 0.2 }, at);
  };
  const zoom = (index: number, at: number) => timeline.to(frames[index], { scale: 1.18, duration: 0.7, ease: "power2.inOut" }, at);
  const action = (name: string, at: number) => timeline.set(root, { attr: { "data-demo-action": name } }, at);
  return { timeline, frames, pointer, move, click, frame, action, zoom };
}
