import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache'
LOCK = json.loads((ROOT / 'dependencies.lock.json').read_text())


def fetch(spec, filename):
    path = CACHE / 'archives' / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != spec['sha256']:
        temporary = path.with_suffix(path.suffix + '.partial')
        with urllib.request.urlopen(spec['url'], timeout=120) as response, temporary.open('wb') as target:
            shutil.copyfileobj(response, target)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != spec['sha256']:
            raise ValueError('Downloaded archive does not match its pinned SHA-256: ' + filename)
        temporary.replace(path)
    return path


def unpack(path, destination):
    destination.mkdir(parents=True, exist_ok=True)
    if path.name.endswith('.zip'):
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                target = (destination / item.filename).resolve()
                if destination.resolve() not in target.parents and target != destination.resolve():
                    raise ValueError('Archive path escapes its directory')
                if item.external_attr >> 16 & 0o170000 == 0o120000:
                    raise ValueError('Archive symlinks are unsupported')
            archive.extractall(destination)
    else:
        with tarfile.open(path) as archive:
            for item in archive.getmembers():
                target = (destination / item.name).resolve()
                if destination.resolve() not in target.parents and target != destination.resolve():
                    raise ValueError('Archive path escapes its directory')
                if not (item.isfile() or item.isdir()):
                    raise ValueError('Archive links are unsupported')
                archive.extract(item, destination)


def configure():
    for name in ['bin', 'data', 'downloads', 'sketchbook']:
        (CACHE / name).mkdir(parents=True, exist_ok=True)
    config = CACHE / 'arduino-cli.json'
    config.write_text(json.dumps({
        'board_manager': {'additional_urls': [LOCK['core']['index']]},
        'directories': {name: str(CACHE / folder) for name, folder in [
            ('data', 'data'), ('downloads', 'downloads'), ('user', 'sketchbook')
        ]},
    }, indent=2) + '\n')
    return config


def cli_command(config):
    binary = CACHE / 'bin' / ('arduino-cli.exe' if os.name == 'nt' else 'arduino-cli')
    if not binary.exists():
        system = {'Darwin': 'macOS', 'Linux': 'Linux', 'Windows': 'Windows'}[platform.system()]
        machine = {'arm64': 'ARM64', 'aarch64': 'ARM64', 'x86_64': '64bit', 'AMD64': '64bit'}[platform.machine()]
        extension = 'zip' if os.name == 'nt' else 'tar.gz'
        name = 'arduino-cli_' + LOCK['arduinoCli']['version'] + '_' + system + '_' + machine + '.' + extension
        unpack(fetch(LOCK['arduinoCli']['assets'][name], name), CACHE / 'bin')
    result = subprocess.check_output([str(binary), 'version', '--format', 'json'], text=True)
    if json.loads(result)['VersionString'] != LOCK['arduinoCli']['version']:
        raise ValueError('Arduino CLI version differs from the dependency lock')
    return [str(binary), '--config-file', str(config), '--no-color']


def image_library(libraries):
    source_root = CACHE / 'vendor/libwebp-1.6.0'
    if not source_root.exists():
        unpack(fetch(LOCK['webp'], 'libwebp-1.6.0.tar.gz'), CACHE / 'vendor')
    library = libraries / 'AlookImages'
    destination = library / 'src'
    destination.mkdir(parents=True, exist_ok=True)
    for source in (source_root / 'src').rglob('*'):
        if source.is_file() and (source.suffix == '.h' or source.suffix == '.c' and source.relative_to(source_root / 'src').parts[0] in ['dec', 'dsp', 'utils', 'demux']):
            target = destination / 'src' / source.relative_to(source_root / 'src')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for source in (source_root / 'sharpyuv').glob('*.h'):
        target = destination / 'sharpyuv' / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    for name, spec in LOCK['stb']['files'].items():
        shutil.copy2(fetch(spec, name), destination / name)
    for name in ['COPYING', 'PATENTS', 'AUTHORS']:
        shutil.copy2(source_root / name, library / name)
    (library / 'library.properties').write_text('name=AlookImages\nversion=1.0.0\nauthor=Alook\nmaintainer=Alook\nsentence=Pinned upstream image decoders for touch.\nparagraph=libwebp and stb\ncategory=Data Processing\narchitectures=esp32\nincludes=AlookImages.h\n')
    (destination / 'AlookImages.h').write_text('#pragma once\n#include "stb_image.h"\n#include "stb_image_resize2.h"\n#include "src/webp/decode.h"\n#include "src/webp/demux.h"\n')
    (destination / 'AlookImages.cpp').write_text('''#include <esp_heap_caps.h>
#define STBI_NO_STDIO
#define STBI_ONLY_JPEG
#define STBI_ONLY_PNG
#define STBI_ONLY_GIF
#define STBI_MAX_DIMENSIONS 2048
#define STBI_MALLOC(n) heap_caps_malloc((n), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define STBI_REALLOC(p,n) heap_caps_realloc((p),(n), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define STBI_FREE(p) heap_caps_free(p)
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STBIR_MALLOC(n,user) heap_caps_malloc((n), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define STBIR_FREE(p,user) heap_caps_free(p)
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"
''')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--libraries-only', action='store_true')
    args = parser.parse_args()
    command = cli_command(configure())
    vendor_root = CACHE / 'vendor'
    vendor_archive = fetch(LOCK['waveshare'], 'waveshare-' + LOCK['waveshare']['commit'] + '.tar.gz')
    vendor = vendor_root / ('ESP32-S3-Touch-AMOLED-1.75C-' + LOCK['waveshare']['commit'])
    if not vendor.exists():
        unpack(vendor_archive, vendor_root)
    libraries = CACHE / 'sketchbook/libraries'
    libraries.mkdir(parents=True, exist_ok=True)
    for name in ['GFX_Library_for_Arduino', 'SensorLib', 'XPowersLib', 'lvgl', 'board_config']:
        shutil.copytree(vendor / 'examples/arduino/libraries' / name, libraries / name, dirs_exist_ok=True)
    shutil.copy2(ROOT / 'firmware/lv_conf.h', libraries / 'lv_conf.h')
    for spec in LOCK['libraries']:
        archive = fetch(spec, spec['name'] + '-' + spec['version'] + '.zip')
        unpack(archive, libraries)
    image_library(libraries)
    if not args.libraries_only:
        subprocess.run(command + ['core', 'update-index'], check=True)
        subprocess.run(command + ['core', 'install', LOCK['core']['id'] + '@' + LOCK['core']['version']], check=True)
    print('touch dependencies ready in ' + str(CACHE))


if __name__ == '__main__':
    main()
