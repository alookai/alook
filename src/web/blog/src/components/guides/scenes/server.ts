import { demoMotion } from "./motion";

export function createScene(root: HTMLElement, complete: () => void) {
  const { timeline, frames, move, click, frame, action, zoom } = demoMotion(root, complete);
  const target = (index: number, selector: string) => frames[index].querySelector(selector)!;
  const update = (element: Element, detail: object, at: number) => timeline.call(() => { element.dispatchEvent(new CustomEvent("tutorial-state", { detail })); }, [], at);
  const form = target(1, "[data-server-form]");
  const invites = target(3, "[data-invite-form]");
  update(form, { name: "" }, 0);
  update(invites, { milo: false, nova: false }, 0);
  const plus = target(0, '[data-testid="community-server-add"]');
  action("create-server", 0); move(plus, 0.4); zoom(0, 1.4, plus); click(plus, 2.3); frame(0, 1, 3.6);
  const name = target(1, '[data-testid="community-create-server-name"]');
  zoom(1, 4, name); click(name, 4.9);
  [..."Studio"].forEach((_, i) => update(form, { name: "Studio".slice(0, i + 1) }, 6 + i * 0.17));
  click(target(1, '[data-testid="community-create-server-submit"]'), 7.5); frame(1, 2, 8.9);
  const invite = target(2, '[aria-label="Invite to server"]');
  action("open-invite", 9); zoom(2, 9.3, invite); click(invite, 10.2); frame(2, 3, 11.6);
  const milo = target(3, '[data-invite-recipient="milo"] button');
  const nova = target(3, '[data-invite-recipient="nova"] button');
  zoom(3, 12, milo); action("invite-milo", 12.9); click(milo, 12.9);
  update(invites, { milo: true }, 14.1);
  action("invite-nova", 15); click(nova, 15);
  update(invites, { nova: true }, 16.2);
  action("invitations-sent", 16.2);
  frame(3, 4, 18.5);
  const members = target(4, '[aria-label="Member list"]');
  zoom(4, 19, members); click(members, 19.9); frame(4, 5, 21.3);
  action("both-joined", 21.3); zoom(5, 21.7, target(5, "[data-members-result]"));
  timeline.to({}, { duration: 3 }, 22.5);
  return timeline;
}
