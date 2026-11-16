import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, click, move, frame, action, zoom } = demoMotion(root, complete);
  const channel = frames[0].querySelector<HTMLElement>('[data-message-channel]')!;
  const task = channel.dataset.messageTask ?? "";
  const editor = frames[0].querySelector('[data-tutorial-editor]')!;
  const choice = (index: number) => frames[0].querySelector(`[data-mention-choice="${index}"]`)!;
  const update = (detail: object) => channel.dispatchEvent(new CustomEvent("tutorial-draft", { detail }));
  timeline.call(() => update({ mentions: 0, text: "", popup: -1 }), [], 0);
  action("open-channel", 0);
  click(frames[0].querySelector(`[data-testid="community-channel-row-${channel.dataset.messageChannelName ?? "general"}"]`) ?? editor, 0.4);
  zoom(0, 1.5, editor);
  click(editor, 2.4);
  const names = [...frames[0].querySelectorAll<HTMLElement>("[data-mention-choice]")].map((node) => node.dataset.mentionName ?? "");
  let at = 3.7;
  for (const [index, name] of names.entries()) {
    if (index > 0) { zoom(0, at - 0.9, editor); move(editor, at - 0.1); }
    action(`mention-${name.toLowerCase()}`, at);
    for (const [step, text] of ["@", `@${name.slice(0, 1)}`, `@${name.slice(0, 2)}`].entries()) timeline.call(() => update({ text }), [], at + 0.1 + step * 0.2);
    timeline.call(() => update({ popup: index }), [], at + 0.8);
    zoom(0, at + 1, choice(index));
    click(choice(index), at + 1.9);
    timeline.call(() => update({ mentions: index + 1, text: "", popup: -1 }), [], at + 3.2);
    at += 4.3;
  }
  const typeAt = at - 0.1;
  zoom(0, typeAt - 0.9, editor);
  move(editor, typeAt - 0.1);
  action("write-task", typeAt);
  for (let count = 1; count <= task.length; count++) timeline.call(() => update({ text: task.slice(0, count) }), [], typeAt + count * 0.07);
  const after = typeAt + task.length * 0.07 + 0.44;
  const sendTarget = frames[0].querySelector('[data-message-composer]')!;
  const send = () => sendTarget.querySelector('[aria-label="Send message"]')!;
  zoom(0, after, send);
  action("send-message", after + 0.9);
  click(send, after + 0.9);
  frame(0, 1, after + 2.3);
  action("message-posted", after + 2.3);
  const result = frames[1].querySelector('[data-message-result]')!;
  zoom(1, after + 2.7, result);
  move(result, after + 3.6);
  timeline.to({}, { duration: 3 }, after + 4.5);
  return timeline;
}
