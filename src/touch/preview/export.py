import base64
import json
import pathlib
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'build/preview'
FONT = ROOT / '.cache/archives/LilitaOne-Regular.ttf'
scenes = {}
for path in sorted(OUTPUT.glob('*.ppm')):
    image = Image.open(path).convert('RGBA')
    mask = Image.new('L', image.size)
    ImageDraw.Draw(mask).ellipse((0, 0, 465, 465), fill=255)
    image.putalpha(mask)
    image.save(path.with_suffix('.png'))
    scenes[path.stem] = 'data:image/png;base64,' + base64.b64encode(path.with_suffix('.png').read_bytes()).decode()


def sheet(filename, items, columns, title='touch / UI preview 17'):
    rows = (len(items) + columns - 1) // columns
    image = Image.new('RGB', (columns * 506, rows * 530 + 80), '#111114')
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(str(FONT), 22)
    detail_font = ImageFont.truetype(str(FONT), 17)
    draw.text((24, 8), title, font=title_font, fill='#ffffff')
    for index, (name, title) in enumerate(items):
        x = 20 + index % columns * 506
        y = 50 + index // columns * 530
        screen = Image.open(OUTPUT / (name + '.png'))
        image.paste(screen, (x, y), screen)
        draw.text((x + 10, y + 472), title, font=title_font, fill='#ffffff')
    draw.text((24, rows * 530 + 52), 'Desktop render / Sample data / Not device evidence / Backend not connected', font=detail_font, fill='#a8a8aa')
    image.save(OUTPUT / filename)


sheet('touch-network-setup-r21.png', [('network-preparing','Preparing / Cancel or manual Wi-Fi'),('network','One setup QR / Manual Wi-Fi fallback'),('network-authorization','Same QR / Check code, then approve'),('network-manual','Manual Wi-Fi / Existing fallback')],2,'Touch / One scan setup / Sample data')
sheet('touch-dm-navigation-v17.png', [('dm-home','Home / Existing DMs'),('dm-human-list','DM list / Refresh only'),('dm-human','Human / No name overlay'),('dm-human-chat','Human DM / Voice input via BOOT'),('dm-bot','BOT / Same avatar style'),('dm-bot-chat','BOT DM / Same voice flow')],3)
sheet('touch-dm-voice-v17.png', [('dm-human-record-ready','Record again / Wait for BOOT'),('dm-human-recording','Hold BOOT / Recording'),('dm-human-transcribing','Release / Transcribing'),('dm-human-review','Full recipient / Review text'),('dm-human-sending','Sending / Controls locked'),('dm-human-send-failed','Send failed / Same intent retry')],3)
sheet('touch-dm-states-v17.png', [('dm-loading','Loading existing DMs'),('dm-empty','No DMs / Refresh'),('dm-list-error','List failure / Retry'),('dm-human-history','History / Latest arrow'),('dm-human-old-tail','Older window / Latest arrow'),('dm-human-no-transcript','No usable transcript / Send disabled')],3)
sheet('touch-dm-permissions-v17.png', [('dm-human-cannot-send','Can read / BOOT blocked'),('dm-human-revoked','Cannot read / History hidden'),('dm-bot-review','BOT / Full recipient')],3)
sheet('touch-retained-pages-v17.png', [('profile','My profile / Received requests'),('nearby','Nearby / Close below primary action'),('settings','More / Existing settings'),('logout','Log out / Explicit confirmation'),('authorization','Sign in / QR'),('network','Wi-Fi setup')],3)

sheet('touch-update-v17.png', [('settings','More / Update entry'),('update-idle','Current version / Not checked'),('update-checking','Checking / No duplicate action'),('update-current','Up to date'),('update-available','New version / Explicit update'),('update-check-failed','Check failed / Retry'),('update-installing','Update progress / Controls locked'),('update-restarting','Installed / Restarting'),('update-install-failed','Update failed / Retry check')],3)

sheet('touch-dm-load-results-v17.png', [('dm-empty','Successful empty response / No DMs'),('dm-list-error','Failed read / No empty-state claim'),('dm-list-error-cached','Failed refresh / Keep cached DMs')],3)

controls = {path.name.removesuffix('.controls.json'): json.loads(path.read_text()) for path in sorted(OUTPUT.glob('*.controls.json'))}
(OUTPUT / 'touch-controls-v17.json').write_text(json.dumps(controls, ensure_ascii=False, indent=2))
template = (ROOT / 'preview/template.html').read_text()
(OUTPUT / 'touch-preview-v17.html').write_text(template.replace('__SCENES__', json.dumps(scenes, ensure_ascii=False)).replace('__CONTROLS__', json.dumps(controls, ensure_ascii=False)))
print('Exported round-screen PNG sheets and a self-contained clickable HTML preview.')
