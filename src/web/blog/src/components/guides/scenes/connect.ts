import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, frame, action, zoom } = demoMotion(root, complete);
  const command = root.querySelector("[data-command-text]")!;
  const caret = root.querySelector("[data-terminal-caret]")!;
  const newline = root.querySelector("[data-terminal-newline]")!;
  const pasteKey = root.querySelector("[data-paste-key]")!;
  const enterKey = root.querySelector("[data-enter-key]")!;
  const entry = frames[0].querySelector("[data-connect-entry]")!;
  const copy = frames[1].querySelector("[data-copy]")!;
  timeline.set(command, { display: "none" }).set(newline, { display: "none" }).set(caret, { autoAlpha: 1 }).set([pasteKey, enterKey], { autoAlpha: 0 });
  action("open-connect", 0);
  move(entry, 0.4);
  zoom(0, 1.5, entry);
  click(entry, 2.4);
  frame(0, 1, 3.8);
  zoom(1, 4.3, copy);
  action("copy-command", 5.2);
  click(copy, 5.2);
  frame(1, 2, 7.2);
  action("paste-command", 7.7);
  move(root.querySelector("[data-terminal-header]")!, 7.7);
  timeline.to(caret, { autoAlpha: 0, duration: 0.08, repeat: 10, repeatDelay: 0.3, yoyo: true }, 7.5);
  timeline.to(pasteKey, { autoAlpha: 1, duration: 0.1 }, 8.6).set(command, { display: "inline" }, 8.8).to(pasteKey, { autoAlpha: 0, duration: 0.1 }, 9.8);
  action("press-enter", 10.3);
  timeline.to(enterKey, { autoAlpha: 1, duration: 0.1 }, 10.3).to(enterKey, { autoAlpha: 0, duration: 0.1 }, 11.3);
  timeline.set(newline, { display: "inline" }, 10.5);
  frame(2, 3, 12);
  action("machine-online", 12);
  timeline.to({}, { duration: 2.5 }, 12.3);
  return timeline;
}
