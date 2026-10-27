import { gsap } from "gsap";

export function createScene(root: HTMLElement, complete: () => void) {
  const frames = root.querySelectorAll<HTMLElement>("[data-demo-frame]");
  const timeline = gsap.timeline({ paused: true, onComplete: complete });
  timeline.set(frames, { autoAlpha: 0 }).set(frames[0], { autoAlpha: 1 });
  timeline.fromTo(frames[0].querySelector("[data-runtime]"), { opacity: 0.4 }, { opacity: 1, duration: 0.25 }, 0.5)
    .to(frames[0], { autoAlpha: 0, duration: 0.2 }, 1.8)
    .to(frames[1], { autoAlpha: 1, duration: 0.2 }, 1.8)
    .fromTo(frames[1].querySelector("[data-runtime]"), { opacity: 0.4 }, { opacity: 1, duration: 0.25 }, 2.3)
    .to(frames[1], { autoAlpha: 0, duration: 0.2 }, 3.8)
    .to(frames[2], { autoAlpha: 1, duration: 0.2 }, 3.8)
    .to({}, { duration: 1.7 });
  return timeline;
}
