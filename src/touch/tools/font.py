import pathlib
import subprocess
import argparse
from setup import ROOT, CACHE, LOCK, fetch


def generate():
    font = fetch(LOCK['font'], LOCK['font']['name'])
    output = ROOT / 'firmware/touch/font_cjk.c'
    subprocess.run([
        'pnpm', '--dir', str(CACHE), 'dlx', LOCK['font']['converter'],
        '--font', str(font), '--size', '20', '--bpp', '2', '--format', 'lvgl',
        '--range', '0x20-0x024f,0x2000-0x206f,0x3000-0x30ff,0x3400-0x9fff,0xff00-0xffef',
        '--no-kerning', '--lv-include', 'lvgl.h', '--lv-font-name', 'alook_font_cjk', '--output', str(output),
    ], check=True)


def generate_ui():
    font = fetch(LOCK['uiFont'], LOCK['uiFont']['name'])
    for size in [24, 32]:
        subprocess.run([
            'pnpm', '--dir', str(CACHE), 'dlx', LOCK['font']['converter'],
            '--font', str(font), '--size', str(size), '--bpp', '4', '--format', 'lvgl',
            '--range', '0x20-0xff', '--no-kerning', '--lv-include', 'lvgl.h',
            '--lv-font-name', 'alook_font_ui_' + str(size),
            '--output', str(ROOT / ('firmware/touch/font_ui_' + str(size) + '.c')),
        ], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ui-only', action='store_true')
    options = parser.parse_args()
    if not options.ui_only:
        generate()
    generate_ui()
