"""Build a reproducible extension-only ZIP with a strict 10 MB release budget."""

import argparse
import gzip
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 10_000_000  # Decimal MB, for both the ZIP and its uncompressed contents.
ENTRY_POINTS = ("manifest.json", "config.js", "app.html", "app.css")


def package_files(root=ROOT):
    """Include only runtime sources and inventoried dependencies; verify every byte."""
    root = root.resolve()
    names = set(ENTRY_POINTS) | {"vendor/README.md", "vendor/inventory.json"}
    names.update(p.relative_to(root).as_posix() for p in (root / "src").rglob("*.js"))
    inventory = json.loads((root / "vendor/inventory.json").read_text("utf-8"))
    expected = {}
    for package in inventory:
        for entry in package["files"]:
            name = "vendor/" + entry["path"]
            if name in expected:
                raise ValueError(f"Duplicate inventory entry: {name}")
            expected[name] = entry
            names.add(name)
    files = {}
    for name in sorted(names):
        path = root / name
        resolved = path.resolve()
        if not resolved.is_relative_to(root) or path.is_symlink():
            raise ValueError(f"Unsafe package path: {name}")
        data = path.read_bytes()
        if not name.startswith("vendor/"):
            # Git may check out CRLF on Windows; release bytes must match Linux CI.
            data = data.replace(b"\r\n", b"\n")
        entry = expected.get(name)
        if entry:
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Vendor integrity mismatch: {name}")
            if entry.get("encoding") == "gzip":
                original = gzip.decompress(data)
                if (len(original) != entry["sourceBytes"] or
                        hashlib.sha256(original).hexdigest() != entry["sourceSha256"]):
                    raise ValueError(f"Compressed source integrity mismatch: {name}")
        files[name] = data
    # Unexpected vendor files must be reviewed, not silently shipped or ignored.
    actual = {p.relative_to(root).as_posix() for p in (root / "vendor").rglob("*")
              if p.is_file() and p.name != ".gitattributes"}
    extras = actual - names
    if extras:
        raise ValueError(f"Uninventoried vendor files: {', '.join(sorted(extras))}")
    return files


def build_zip(files, limit=MAX_BYTES):
    expanded_bytes = sum(len(data) for data in files.values())
    if expanded_bytes > limit:
        raise ValueError(f"Unpacked extension is {expanded_bytes:,} bytes; limit is {limit:,}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    zipped = buffer.getvalue()
    if len(zipped) > limit:
        raise ValueError(f"Extension ZIP is {len(zipped):,} bytes; limit is {limit:,}")
    return zipped, {"files": len(files), "unpackedBytes": expanded_bytes,
                    "zipBytes": len(zipped), "limitBytes": limit,
                    "sha256": hashlib.sha256(zipped).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without writing the ZIP")
    args = parser.parse_args()
    try:
        files = package_files()
        zipped, report = build_zip(files)
        version = json.loads(files["manifest.json"])["version"]
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", version):
            raise ValueError("Invalid manifest version")
        if not args.check:
            destination = ROOT.parents[1] / "dist" / f"filewise-{version}.zip"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(zipped)
            report["artifact"] = str(destination)
        print(json.dumps(report, indent=2))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Extension packaging failed: {error}\n")


if __name__ == "__main__":
    main()
