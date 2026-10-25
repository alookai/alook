"""Create a neutral 90 BPM review click, ending before the final CTA hold."""
import math
import struct
import wave
from pathlib import Path
sample_rate = 48000
frames = 1432
samples = bytearray()
for n in range(round(sample_rate * frames / 30)):
    t = n / sample_rate
    beat = int(t * 1.5)
    phase = t - beat / 1.5
    accented = beat % 4 == 0
    value = ((.17 if accented else .10)
             * math.sin(2 * math.pi * (1000 if accented else 740) * phase)
             * math.exp(-phase * 110)) if phase < .065 and beat < 71 else 0
    samples += struct.pack('<h', round(value * 32767))
Path('out').mkdir(exist_ok=True)
with wave.open('out/beat-guide-90bpm.wav', 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(sample_rate)
    output.writeframes(samples)
