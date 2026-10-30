import argparse
from contextlib import ExitStack
import json
from pathlib import Path, PurePosixPath
import os
import shutil
import stat
import tempfile
from zipfile import BadZipFile, ZipFile


def downloaded_archives(root):
    entries = sorted(root.iterdir())
    if not entries or any(entry.is_symlink() for entry in entries):
        raise ValueError("Expected nonempty regular artifact downloads")
    if len(entries) == 1 and entries[0].is_file():
        return [(None, entries[0])]
    if not all(entry.is_dir() for entry in entries):
        raise ValueError("Expected separate artifact directories or one flat archive")
    archives = []
    for entry in entries:
        files = list(entry.iterdir())
        if len(files) != 1 or files[0].is_symlink() or not files[0].is_file():
            raise ValueError("Each artifact download must contain exactly one regular archive")
        archives.append((entry.name, files[0]))
    return archives


def validate_archive(archive):
    names = set()
    files = []
    directories = {"blob-report/", "e2e-shard-manifest/"}
    for member in archive.infolist():
        name = member.filename
        parts = PurePosixPath(name).parts
        if (not name or "\\" in name or name.startswith("/")
                or any(part in {".", ".."} for part in name.split("/"))
                or ":" in name or name in names):
            raise ValueError("Unsafe or duplicate report archive member")
        names.add(name)
        mode = member.external_attr >> 16
        if stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise ValueError("Report archive members must be regular files or directories")
        if member.is_dir():
            if name not in directories:
                raise ValueError("Unexpected report archive directory")
        elif (len(parts) == 2 and parts[0] == "blob-report" and parts[1].endswith(".zip")):
            files.append("blob")
        elif name == "e2e-shard-manifest/shard-manifest.json":
            files.append("manifest")
        else:
            raise ValueError("Unexpected report archive file")
    if sorted(files) != ["blob", "manifest"]:
        raise ValueError("Expected exactly one blob ZIP and one shard manifest")
    bad_member = archive.testzip()
    if bad_member is not None:
        raise ValueError("Report archive CRC verification failed")


def extract_reports(root, output):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Artifact download root must be a regular directory")
    root = root.resolve()
    if output.exists() or output.is_symlink():
        raise ValueError("Report extraction output must not already exist")
    output = output.resolve()
    if root == output or root in output.parents or output in root.parents:
        raise ValueError("Raw archive and extraction paths must be separate")
    inputs = downloaded_archives(root)
    with ExitStack() as stack:
        archives = [(name, stack.enter_context(ZipFile(path))) for name, path in inputs]
        for _, archive in archives:
            validate_archive(archive)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
        try:
            for name, archive in archives:
                archive.extractall(temporary / name if name is not None else temporary)
            os.replace(temporary, output)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return {"artifacts": len(inputs), "files": len(inputs) * 2, "output": str(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(extract_reports(args.root, args.output)))
    except (OSError, ValueError, BadZipFile, RuntimeError) as error:
        raise SystemExit(f"Cannot extract report artifacts: {error}") from error


if __name__ == "__main__":
    main()
