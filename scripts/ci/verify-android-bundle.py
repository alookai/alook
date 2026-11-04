import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import xml.etree.ElementTree as ET
import zipfile


ANDROID = "{http://schemas.android.com/apk/res/android}"


def native(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise ValueError(f"{Path(command[0]).name} failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout


def metadata(manifest, names, certificate, version_name, version_code, expected_certificate):
    root = ET.fromstring(manifest)
    if root.tag != "manifest" or root.get("package") != "ai.alook.android":
        raise ValueError("Unexpected Android bundle package")
    if root.get(ANDROID + "versionName") != version_name or root.get(ANDROID + "versionCode") != str(version_code):
        raise ValueError("Android bundle version differs from this release")
    application = root.find("application")
    if application is None or application.get(ANDROID + "debuggable") == "true":
        raise ValueError("Android bundle must contain a release application")
    abis = sorted({name.split("/")[2] for name in names if re.fullmatch(r"base/lib/[^/]+/[^/]+\.so", name)})
    if abis != ["arm64-v8a", "armeabi-v7a"]:
        raise ValueError("Android bundle must contain both release ARM architectures")
    certificates = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", certificate, re.S)
    if not certificates:
        raise ValueError("Android bundle has no signing certificate")
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificates[0])).hexdigest().upper()
    if fingerprint != expected_certificate.replace(":", "").upper():
        raise ValueError("Android bundle signing certificate differs from the direct APK")
    return dict(package="ai.alook.android", versionName=version_name, versionCode=version_code,
                certificateSha256=fingerprint, abis=abis)


def verify(args):
    if not re.fullmatch(r"[1-9][0-9]*", args.version_code) or int(args.version_code) > 2100000000:
        raise ValueError("Invalid Android versionCode")
    for key in ["SIGNING_STORE_FILE", "SIGNING_STORE_PASSWORD"]:
        if not os.environ.get(key):
            raise ValueError(f"Missing Android verification input: {key}")
    source, output = Path(args.bundle), Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as incoming, output.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    native(["jarsigner", "-verify", "-strict", "-keystore", os.environ["SIGNING_STORE_FILE"],
            "-storepass:env", "SIGNING_STORE_PASSWORD", str(output)])
    certificate = native(["keytool", "-J-Duser.language=en", "-printcert", "-jarfile", str(output), "-rfc"])
    native(["java", "-jar", args.bundletool, "validate", "--bundle", str(output)])
    manifest = native(["java", "-jar", args.bundletool, "dump", "manifest", "--bundle", str(output), "--module", "base"])
    with zipfile.ZipFile(output) as archive:
        result = metadata(manifest, archive.namelist(), certificate, args.version_name,
                          int(args.version_code), args.certificate_sha256)
    result.update(path=str(output), bytes=output.stat().st_size, sha256=hashlib.sha256(output.read_bytes()).hexdigest())
    Path(args.receipt).write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ["bundle", "bundletool", "version-name", "version-code", "certificate-sha256", "output", "receipt"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args)))
    except (ValueError, OSError, subprocess.SubprocessError, ET.ParseError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Android bundle verification failed: {error}\n")


if __name__ == "__main__":
    main()
