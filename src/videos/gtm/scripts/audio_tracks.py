from dataclasses import dataclass
from typing import Callable
import array
import math
import subprocess
from sfx_track import RATE, build_base_sfx, read_sound
from current_timeline import TIMELINE, FULL_FRAMES, card_intervals, full_frame_map


def clean_frame_map(frame):
    return frame + 159 + (76 if frame >= 907 else 0) + (96 if frame >= 1251 else 0) + (96 if frame >= 1771 else 0)



@dataclass(frozen=True)
class OpeningProfile:
    frames: int
    frame_map: Callable[[int], int]
    opening_offset: float
    join_start: float
    drop_end: float
    click_times: tuple[float, ...]
    air_frames: tuple[int, ...]


CLEAN_PROFILE = OpeningProfile(3047, clean_frame_map, 3.1, 10.9, 15.213, (1.62, 2.45, 3.3, 3.6, 3.85), (1066, 1486, 2102))
FULL_PROFILE = OpeningProfile(FULL_FRAMES, full_frame_map, 3.7, 11.5, 15.813, (1.62, 2.45, 3.35, 3.6, 3.85), tuple(start for start, *_ in card_intervals()))


def build_opening_sfx(root, profile):
    sr = RATE
    track, cues = build_base_sfx(root, profile.frames, lambda frame: profile.frame_map(frame) if frame >= TIMELINE["storySourceStartFrame"] else None)

    def add_at(name, time, db, length=None):
        data = read_sound(root, name)
        if length is not None:
            data = data[:round(length * sr)]
        gain = 32767 * 10 ** (db / 20) / max(map(abs, data))
        at = round(time * sr)
        for i, value in enumerate(data):
            envelope = min(1, (i + 1) / 96, (len(data) - i) / 96)
            track[at + i] += value * gain * envelope
        cues.append({'sound': name[:2], 'frame': round(time * 30), 'startSample': at, 'samples': len(data), 'peakDb': db})

    source_times = TIMELINE["firstActSourceTimes"]
    output_times = TIMELINE["firstActPlaybackTimes"]
    def opening_time(t):
        i = next(i for i in range(len(source_times)-1) if source_times[i] <= t <= source_times[i+1])
        return profile.opening_offset + output_times[i] + (t-source_times[i])/(source_times[i+1]-source_times[i])*(output_times[i+1]-output_times[i])

    add_at('04-join-drop.wav', opening_time(.75), -19)
    for t in profile.click_times:
        add_at('02-click.wav', opening_time(t), -18)
    for offset in [0, .85, 1.55, 2.15, 2.65, 3.05, 3.4, 3.68, 3.9, 4.08]:
        add_at('04-join-drop.wav', profile.join_start + offset, -26)
    add_at('04-join-drop.wav', profile.drop_end, -18)
    for frame in profile.air_frames:
        add_at('14-soft-air.wav', frame / 30, -25, .24)

    assert max(map(abs, track)) < 32767
    assert len(track) == profile.frames * 1600
    return track, cues


def normalize_sfx(track):
    return array.array('f', (v / 32767 * 10 ** (5/20) for v in track))


def load_music(root):
    filters = 'loudnorm=I=-21:TP=-3:LRA=11,aresample=48000'
    return array.array('f', subprocess.check_output(['ffmpeg','-v','error','-i',str(root/'public/bgm/jazz-funk/03-dirty-thinkin.mp3'),'-af',filters,'-ac','2','-ar',str(RATE),'-f','f32le','-']))
