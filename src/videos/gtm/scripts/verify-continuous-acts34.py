import json
import subprocess
from pathlib import Path
from PIL import Image, ImageChops, ImageStat, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / 'out'
video = out / 'alook-acts34-continuous-story.mp4'
info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(video)]))
assert len(info['streams']) == 1
stream = info['streams'][0]
assert (stream['width'], stream['height'], int(stream['nb_frames'])) == (1920, 1080, 915)
frames = [0, 150, 314, 315, 336, 345, 375, 420, 510, 630, 750, 914]
images = []
for frame in frames:
    target = out / f'acts34-encoded-{frame}.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'select=eq(n\\,{frame})', '-frames:v', '1', '-y', str(target)], check=True)
    images.append(Image.open(target).convert('RGB'))
a, b = [images[frames.index(frame)].crop((0, 0, 1920, 930)) for frame in [314, 315]]
error = sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3
assert error < 1, f'Boundary image drift: {error}'
canvas = Image.new('RGB', (1200, 1000), '#ddd')
draw = ImageDraw.Draw(canvas)
for i, (frame, im) in enumerate(zip(frames, images)):
    im.thumbnail((400, 225))
    x, y = i % 3 * 400, i // 3 * 250
    canvas.paste(im, (x, y))
    draw.text((x + 5, y + 228), f'{frame / 30:.3f}s / frame {frame}', fill='black')
canvas.save(out / 'acts34-encoded-qa.jpg')
print(f'PASS: 915 frames, 1080p, silent; boundary pixel mean error {error:.4f}; extracted 12 QA frames including final frame 914.')
