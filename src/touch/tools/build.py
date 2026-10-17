import json
import hashlib
import csv
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache'
sys.path.insert(0, str(ROOT / 'tools'))
from setup import cli_command, configure
from release import prepare, metadata, eligible

FQBN = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=32M,PartitionScheme=app13M_data7M_32MB,PSRAM=opi,FlashMode=qio'


def prepare_client_configuration(root, client_id='', require_secret=False):
    if require_secret and not client_id:
        raise ValueError('Touch release requires the TOUCH_CLIENT_ID secret')
    value = client_id or 'alook-touch-dev'
    if len(value) > 128 or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError('TOUCH_CLIENT_ID must contain 1-128 printable non-space ASCII characters')
    header = root / 'firmware/touch/generated/client_id.h'
    header.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(header, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write('#pragma once\n#define ALOOK_TOUCH_CLIENT_ID ' + json.dumps(value) + '\n')
    return header


def source_inputs():
    files = [ROOT / 'dependencies.lock.json', ROOT / '.deploy-version', ROOT / 'firmware/lv_conf.h', ROOT / 'tools/build.py', ROOT / 'tools/release.py']
    files += sorted(path for path in (ROOT / 'firmware/touch').rglob('*') if path.is_file() and path.suffix in {'.h', '.cpp', '.c', '.ino', '.csv'})
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}


def main():
    info = prepare()
    require_secret = eligible() and os.environ.get('GITHUB_EVENT_NAME') != 'pull_request'
    prepare_client_configuration(ROOT, os.environ.get('TOUCH_CLIENT_ID', ''), require_secret=require_secret)
    command = cli_command(configure())
    inputs = source_inputs()
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    options = [
        'compile', '--fqbn', FQBN, '--jobs', '2',
        '--build-path', str(build / 'objects'), '--output-dir', str(build / 'firmware'),
        str(ROOT / 'firmware/touch'),
    ]
    with (build / 'compile.log').open('w') as output:
        result = subprocess.run(command + options, stdout=output, stderr=subprocess.STDOUT)
    print((build / 'compile.log').read_text()[-10000:])
    if result.returncode:
        raise SystemExit(result.returncode)
    if inputs != source_inputs() or info != metadata():
        raise SystemExit('Firmware inputs changed during compilation; rebuild the stable candidate')
    partitions = []
    for row in csv.reader((build / 'objects/partitions.csv').read_text().splitlines()):
        if row and not row[0].lstrip().startswith('#'):
            partitions.append({'name': row[0].strip(), 'type': row[1].strip(), 'subtype': row[2].strip(), 'offset': int(row[3].strip(), 0), 'size': int(row[4].strip(), 0)})
    apps = [row for row in partitions if row['type'] == 'app']
    if {row['subtype'] for row in apps} != {'ota_0', 'ota_1'} or any(row['offset'] + row['size'] > 32 * 1024 * 1024 for row in partitions):
        raise SystemExit('Expected the selected 32MB dual-OTA partition layout')
    firmware = build / 'firmware/touch.ino.bin'
    image = firmware.read_bytes()
    if any(info[key].encode() not in image for key in ['version', 'sourceCommit', 'hardware', 'partitionLayout']):
        raise SystemExit('Compiled firmware is missing its declared build identity')
    if len(image) > min(row['size'] for row in apps):
        raise SystemExit('Firmware exceeds an OTA application slot')
    receipt = {
        'fqbn': FQBN, 'source': str(ROOT / 'firmware/touch'),
        'source_sha256': inputs, 'partitions': partitions,
        'binary': {'bytes': len(image), 'sha256': hashlib.sha256(image).hexdigest()},
        'dependencies': json.loads((ROOT / 'dependencies.lock.json').read_text()),
        'buildInfo': info,
    }
    (build / 'compile-input.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
