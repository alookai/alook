import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
HARDWARE = 'waveshare-esp32-s3-touch-amoled-1.75c'
LAYOUT = 'default_32MB-ota-c80000-v1'
VERSION = r'(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})\.(?:0|[1-9][0-9]{0,7})'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE).strip()


def metadata(root=ROOT):
    version = (root / '.deploy-version').read_text().strip()
    if not re.fullmatch(VERSION, version):
        raise ValueError('Touch requires a stable numeric component version')
    return {'version': version, 'sourceCommit': git(root, 'rev-parse', 'HEAD'),
            'dirty': bool(git(root, 'status', '--porcelain', '--untracked-files=normal')),
            'hardware': HARDWARE, 'partitionLayout': LAYOUT}


def prepare(root=ROOT):
    info = metadata(root)
    header = root / 'firmware/touch/generated/build_info.h'
    header.parent.mkdir(parents=True, exist_ok=True)
    text = '#pragma once\nnamespace alook_touch {\n'
    for name, key in [('firmware_version', 'version'), ('firmware_source', 'sourceCommit'), ('hardware_id', 'hardware'), ('partition_layout', 'partitionLayout')]:
        text += 'inline constexpr const char* ' + name + ' = ' + json.dumps(info[key]) + ';\n'
    text += 'inline constexpr bool firmware_dirty = ' + ('true' if info['dirty'] else 'false') + ';\n'
    text += '}\n'
    if not header.exists() or header.read_text() != text:
        header.write_text(text)
    return info


def eligible(root=ROOT):
    info = metadata(root)
    if info['dirty'] or git(root, 'log', '-1', '--format=%s') != 'release: v' + info['version']:
        return False
    try:
        previous = git(root, 'show', 'HEAD^:src/touch/.deploy-version')
    except subprocess.CalledProcessError:
        return False
    return previous != info['version']


def stage(root=ROOT):
    if not eligible(root):
        raise ValueError('Only a clean unified release commit that changes an existing Touch version can publish')
    info = metadata(root)
    build = root / 'build'
    receipt = json.loads((build / 'compile-input.json').read_text())
    if receipt.get('buildInfo') != info:
        raise ValueError('Build version, source commit or working tree differs from the release')
    for relative, digest in receipt['source_sha256'].items():
        if hashlib.sha256((root / relative).read_bytes()).hexdigest() != digest:
            raise ValueError('Build source changed: ' + relative)
    image = (build / 'firmware/touch.ino.bin').read_bytes()
    binary = {'bytes': len(image), 'sha256': hashlib.sha256(image).hexdigest()}
    if binary != receipt['binary']:
        raise ValueError('Build binary changed')
    apps = [part for part in receipt['partitions'] if part['type'] == 'app']
    if [(part['subtype'], part['offset'], part['size']) for part in apps] != [('ota_0', 0x10000, 0xc80000), ('ota_1', 0xc90000, 0xc80000)] or not 0 < len(image) <= 0xc80000:
        raise ValueError('Build partition layout is incompatible')
    tag = 'v' + info['version']
    name = 'alook-touch-' + info['version'] + '.bin'
    manifest = {'schemaVersion': 1, 'component': 'touch', 'version': info['version'],
                'tag': tag, 'sourceCommit': info['sourceCommit'], 'hardware': HARDWARE,
                'partitionLayout': LAYOUT, 'binary': {'name': name, **binary}}
    destination = build / 'release'
    destination.mkdir(exist_ok=True)
    shutil.copyfile(build / 'firmware/touch.ino.bin', destination / name)
    (destination / 'alook-touch-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def verify_stage(root=ROOT):
    info = metadata(root)
    manifest = json.loads((root / 'build/release/alook-touch-manifest.json').read_text())
    if info['dirty'] or any(manifest.get(key) != info[key] for key in ['version', 'sourceCommit', 'hardware', 'partitionLayout']) or manifest.get('tag') != 'v' + info['version'] or manifest.get('schemaVersion') != 1 or manifest.get('component') != 'touch':
        raise ValueError('Staged manifest does not match the clean release checkout')
    binary = manifest['binary']
    if binary['name'] != 'alook-touch-' + info['version'] + '.bin':
        raise ValueError('Unexpected release asset name')
    image = (root / 'build/release' / binary['name']).read_bytes()
    if len(image) != binary['bytes'] or not 0 < len(image) <= 0xc80000 or hashlib.sha256(image).hexdigest() != binary['sha256']:
        raise ValueError('Staged release bytes changed')
    if git(root, 'rev-parse', manifest['tag'] + '^{commit}') != info['sourceCommit']:
        raise ValueError('Release tag differs from the compiled source commit')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'eligible', 'stage', 'verify-stage'])
    args = parser.parse_args()
    if args.command == 'eligible':
        print('true' if eligible() else 'false')
    else:
        print(json.dumps(prepare() if args.command == 'prepare' else verify_stage() if args.command == 'verify-stage' else stage()))


if __name__ == '__main__':
    main()
