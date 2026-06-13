import type { CloudCodeMonsterActivity, CloudCodeMonsterActivityId } from "./cloud-code-monster-pet-types";

export const CLOUD_CODE_MONSTER_ACTIVITIES: CloudCodeMonsterActivity[] = [
  { id: "attention", label: "Attention", caption: "Celebrating a finished task" },
  { id: "building", label: "Building", caption: "Coordinating several agents" },
  { id: "carrying", label: "Carrying", caption: "Moving a fresh workspace bundle" },
  { id: "coding", label: "Coding", caption: "Tapping through a small patch" },
  { id: "dozing", label: "Dozing", caption: "Getting ready to sleep" },
  { id: "sleeping", label: "Sleeping", caption: "Resting quietly on the desk" },
  { id: "error", label: "Error", caption: "A task needs attention" },
  { id: "juggling", label: "Juggling", caption: "Keeping multiple agent tasks in motion" },
  { id: "notification", label: "Notification", caption: "Ringing for a new unread message" },
  { id: "reading", label: "Reading", caption: "Flipping through a thick doc" },
  { id: "phone", label: "On phone", caption: "Checking a tiny glowing screen" },
  { id: "thinking", label: "Thinking", caption: "Processing a background thought" },
  { id: "snacking", label: "Snacking", caption: "Chewing on a little energy block" },
  { id: "sweeping", label: "Sweeping", caption: "Tidying up workspace context" },
  { id: "typing", label: "Typing", caption: "Following the user's live input" },
  { id: "waking", label: "Waking", caption: "Coming back online" },
  { id: "yawning", label: "Yawning", caption: "Powering down after quiet time" },
];

export const CLOUD_CODE_MONSTER_WORKING_ACTIVITY_IDS: readonly CloudCodeMonsterActivityId[] = [
  "building",
  "coding",
  "juggling",
  "thinking",
  "reading",
  "typing",
];

export const CLOUD_CODE_MONSTER_AUTOWALK_ACTIVITY_IDS: readonly CloudCodeMonsterActivityId[] = [
  "reading",
  "phone",
  "snacking",
];
