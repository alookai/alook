import { gsap } from "gsap";

export function createScene(root: HTMLElement, complete: () => void) {
  const frames = root.querySelectorAll<HTMLElement>("[data-demo-frame]");
  const timeline = gsap.timeline({ paused: true, onComplete: complete });
  timeline.set(frames, { autoAlpha: 0 }).set(frames[0], { autoAlpha: 1 });
  timeline.to(frames[0], { autoAlpha: 0, duration: 0.2 }, 1.6)
    .to(frames[1], { autoAlpha: 1, duration: 0.2 }, 1.6)
    .fromTo(root.querySelector("[data-command]"), { opacity: 0.25 }, { opacity: 1, duration: 0.2 }, 2)
    .to(frames[1], { autoAlpha: 0, duration: 0.2 }, 4)
    .to(frames[2], { autoAlpha: 1, duration: 0.2 }, 4)
    .to({}, { duration: 1.8 });
  return timeline;
}
