from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "assets-manifest.json").read_text())
errors = []
for name, expected in manifest.items():
    path = root / name
    if not path.is_file():
        errors.append(f"Missing {name}")
        continue
    data = path.read_bytes()
    if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        errors.append(f"Mismatch {name}")
if errors:
    raise SystemExit("\n".join(errors) + "\nSee ASSETS.md for setup.")
print(f"PASS: {len(manifest)} media assets match the manifest.")
