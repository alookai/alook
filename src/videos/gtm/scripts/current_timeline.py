import json
from pathlib import Path

TIMELINE = json.loads((Path(__file__).resolve().parent.parent / "src/current-timeline.json").read_text(encoding="utf-8"))
FPS = TIMELINE["fps"]
STORY_CARDS = TIMELINE["storyCards"]
REVIEW_SEGMENTS = TIMELINE["reviewSegments"]
BASE_SHIFT = TIMELINE["firstActFrames"] - TIMELINE["storySourceStartFrame"]


def card_frames(card):
    return TIMELINE["cardFrames"] + card["holdFrames"]


def card_net_frames(card):
    return card_frames(card) - (card["resumeFrame"] - card["sourceFrame"])


def card_intervals():
    inserted = 0
    for card in STORY_CARDS:
        start = card["sourceFrame"] + BASE_SHIFT + inserted
        yield start, card_frames(card), len(card["lines"]), card["verificationExitFrame"]
        inserted += card_net_frames(card)


STORY_FRAMES = REVIEW_SEGMENTS[-1]["toFrame"] - TIMELINE["storySourceStartFrame"] + sum(map(card_net_frames, STORY_CARDS))
FULL_FRAMES = TIMELINE["firstActFrames"] + STORY_FRAMES + TIMELINE["endingFrames"]
LATE_SOURCE_SHIFT = BASE_SHIFT + sum(map(card_net_frames, STORY_CARDS))


def full_frame_map(frame):
    return frame + BASE_SHIFT + sum(card_net_frames(card) for card in STORY_CARDS if frame >= card["cueShiftFrom"])
