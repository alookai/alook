import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, pointer, click, move, frame, action, zoom } = demoMotion(root, complete);
  const command = root.querySelector("[data-command-text]")!;
  const copyLabel = root.querySelector("[data-copy-label]")!;
  const copied = root.querySelector("[data-copied]")!;
  const pasteKey = root.querySelector("[data-paste-key]")!;
  const enterKey = root.querySelector("[data-enter-key]")!;
  timeline.set(command, { autoAlpha: 0 }).set([pasteKey, enterKey, copied], { autoAlpha: 0 }).set(copied, { display: "none" }).set(copyLabel, { display: "inline" });
  action("open-connect", 0);
  zoom(0, 0.5);
  click(root.querySelector("[data-connect-entry]")!, 1.3);
  frame(0, 1, 2.3);
  action("copy-command", 2.8);
  click(root.querySelector("[data-copy]")!, 3.0);
  timeline.set(copyLabel, { display: "none" }, 3.7).set(copied, { display: "inline", autoAlpha: 1 }, 3.7);
  frame(1, 2, 4.5);
  action("paste-command", 5);
  move(root.querySelector("[data-command]")!, 5);
  timeline.to(pasteKey, { autoAlpha: 1, duration: 0.1 }, 5.6).set(command, { autoAlpha: 1 }, 5.8).to(pasteKey, { autoAlpha: 0, duration: 0.1 }, 6.7);
  action("press-enter", 7.2);
  timeline.to(enterKey, { autoAlpha: 1, duration: 0.1 }, 7.2).to(pointer, { autoAlpha: 0, duration: 0.2 }, 7.2).to(enterKey, { autoAlpha: 0, duration: 0.1 }, 8.2);
  frame(2, 3, 9);
  action("machine-online", 9);
  timeline.to({}, { duration: 2 }, 9.2);
  return timeline;
}
