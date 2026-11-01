import { demoMotion } from "./motion";

const task = "Agree on roles, then wait for my task.";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, frame, action, zoom } = demoMotion(root, complete);
  const channel = frames[0].querySelector('[data-message-channel]')!;
  const editor = frames[0].querySelector('[data-tutorial-editor]')!;
  const choice = (index: number) => frames[0].querySelector(`[data-mention-choice="${index}"]`)!;
  const update = (detail: object) => channel.dispatchEvent(new CustomEvent("tutorial-draft", { detail }));
  timeline.call(() => update({ mentions: 0, text: "", popup: -1 }), [], 0);
  action("open-channel", 0);
  click(frames[0].querySelector('[data-testid="community-channel-row-general"]')!, 0.4);
  zoom(0, 1.5, editor);
  click(editor, 2.4);
  action("mention-milo", 3.7);
  for (const [index, text] of ["@", "@M", "@Mi"].entries()) timeline.call(() => update({ text }), [], 3.8 + index * 0.2);
  timeline.call(() => update({ popup: 0 }), [], 4.5);
  zoom(0, 4.7, choice(0));
  click(choice(0), 5.6);
  timeline.call(() => update({ mentions: 1, text: "", popup: -1 }), [], 6.9);
  zoom(0, 7.1, editor);
  move(editor, 7.9);
  action("mention-nova", 8);
  for (const [index, text] of ["@", "@N", "@No"].entries()) timeline.call(() => update({ text }), [], 8 + index * 0.2);
  timeline.call(() => update({ popup: 1 }), [], 8.7);
  zoom(0, 8.9, choice(1));
  click(choice(1), 9.8);
  timeline.call(() => update({ mentions: 2, text: "", popup: -1 }), [], 11.1);
  zoom(0, 11.3, editor);
  move(editor, 12.1);
  action("write-task", 12.2);
  for (let count = 1; count <= task.length; count++) timeline.call(() => update({ text: task.slice(0, count) }), [], 12.2 + count * 0.07);
  const sendTarget = frames[0].querySelector('[data-message-composer]')!;
  const send = () => sendTarget.querySelector('[aria-label="Send message"]')!;
  zoom(0, 15.3, send);
  action("send-message", 16.2);
  click(send, 16.2);
  frame(0, 1, 17.6);
  action("message-posted", 17.6);
  const result = frames[1].querySelector('[data-message-result]')!;
  zoom(1, 18, result);
  move(result, 18.9);
  timeline.to({}, { duration: 3 }, 19.8);
  return timeline;
}
