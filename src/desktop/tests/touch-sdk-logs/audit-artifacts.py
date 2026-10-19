import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import tempfile
import zipfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(path, dexdump, names):
    current = ''
    classes = set()
    violations = []
    process = subprocess.Popen([str(dexdump), '-d', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors='replace')
    for line in process.stdout:
        match = re.search(r"Class descriptor\s*:\s*'L([^;]+);'", line)
        if match:
            current = match.group(1)
            if current.startswith(('com/espressif/provisioning/', 'ai/alook/plugin/touchsetup/')) or current in names:
                classes.add(current)
        if current not in classes or 'invoke-' not in line:
            continue
        if re.search(r'Landroid/util/Log;\.(v|d|i|w|e|wtf|println):', line) or re.search(r';\.printStackTrace:', line):
            violations.append(current)
    error = process.stderr.read()
    if process.wait():
        raise RuntimeError('dexdump failed: ' + error[:160])
    return {'sha256': digest(path), 'classes': len(classes), 'emittingCalls': len(violations)}, classes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=pathlib.Path, required=True)
    parser.add_argument('--dexdump', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    mapping = args.app / 'build/outputs/mapping/universalRelease/mapping.txt'
    names = set()
    for line in mapping.read_text().splitlines():
        if line.startswith(('com.espressif.provisioning.', 'ai.alook.plugin.touchsetup.')) and line.endswith(':') and ' -> ' in line:
            names.add(line.split(' -> ', 1)[1][:-1].replace('.', '/'))
    apk = args.app / 'build/outputs/apk/universal/debug/app-universal-debug.apk'
    result = {'apk': {'path': str(apk), 'sha256': digest(apk)}, 'mapping': {'path': str(mapping), 'sha256': digest(mapping)}, 'variants': {}}
    with tempfile.TemporaryDirectory(prefix='alook-touch-dex-') as directory:
        temporary = pathlib.Path(directory)
        with zipfile.ZipFile(apk) as archive:
            paths = []
            for name in archive.namelist():
                if re.fullmatch(r'classes\d*\.dex', name):
                    path = temporary / name
                    path.write_bytes(archive.read(name))
                    paths.append(path)
        for variant, paths in [('debugApk', paths), ('releaseR8', sorted((args.app / 'build/intermediates/dex/universalRelease/minifyUniversalReleaseWithR8').glob('*.dex')))]:
            if not paths:
                raise RuntimeError('Missing actual ' + variant + ' dex outputs')
            classes = set()
            records = []
            for path in paths:
                record, observed = inspect(path, args.dexdump, names if variant == 'releaseR8' else set())
                records.append({'name': path.name, **record})
                classes.update(observed)
            if len(classes) < 20 or any(record['emittingCalls'] for record in records):
                raise RuntimeError(variant + ' SDK emission audit failed')
            result['variants'][variant] = {'auditedClasses': len(classes), 'dex': records, 'emittingCalls': 0}
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({name: {'classes': value['auditedClasses'], 'emittingCalls': value['emittingCalls']} for name, value in result['variants'].items()}))


if __name__ == '__main__':
    main()
