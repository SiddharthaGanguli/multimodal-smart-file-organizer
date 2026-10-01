"""Maintainer-only: reproduce the locally bundled OCR runtime (no install scripts)."""
import base64
import gzip
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "vendor"
PACKAGES = [
    ("tesseract", "tesseract.js", "7.0.0", "https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz",
     "exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA=="),
    ("tesseract-core", "tesseract.js-core", "7.0.0", "https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz",
     "WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw=="),
    ("tessdata", "@tesseract.js-data/eng", "1.0.0", "https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz",
     "mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg=="),
    ("pdfjs", "pdfjs-dist", "6.3.289", "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz",
     "ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw=="),
]


def destination(group, name):
    if name in {"LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "README.md", "package.json"}:
        return name
    if group == "tesseract" and name.startswith("dist/") and name.endswith(".LICENSE.txt"):
        return Path(name).name
    if group == "tesseract" and name == "dist/worker.min.js":
        return Path(name).name
    # Chrome 125+ supports standard SIMD. Ship one split core, avoiding three
    # duplicate base64-embedded engines. The binary is losslessly gzip-compressed.
    if group == "tesseract-core" and name == "tesseract-core-simd-lstm.js":
        return name
    if group == "tesseract-core" and name == "tesseract-core-simd-lstm.wasm":
        return name + ".gz"
    if group == "tessdata" and name == "4.0.0_best_int/eng.traineddata.gz":
        return "eng.traineddata.gz"
    if group == "pdfjs":
        if name.startswith("wasm/quickjs-eval"):
            return None  # Document scripting is not part of rasterization.
        if name in {"legacy/build/pdf.min.mjs", "legacy/build/pdf.worker.min.mjs"}:
            return Path(name).name
        if name.startswith(("cmaps/", "standard_fonts/", "wasm/")):
            return name
    return None


def main():
    inventory = []
    previous_path = ROOT / "inventory.json"
    previous = json.loads(previous_path.read_text("utf-8")) if previous_path.exists() else []
    for group, package, version, url, integrity in PACKAGES:
        with urllib.request.urlopen(url, timeout=60) as response:
            archive_bytes = response.read(80 * 1024 * 1024 + 1)
        if base64.b64encode(hashlib.sha512(archive_bytes).digest()).decode() != integrity:
            raise ValueError(f"Integrity mismatch for {package}")
        files = []
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            for member in archive.getmembers():
                if not member.isfile() or not member.name.startswith("package/"):
                    continue
                name = member.name[len("package/"):]
                relative = destination(group, name)
                if relative is None:
                    continue
                target = (ROOT / group / relative).resolve()
                if not target.is_relative_to((ROOT / group).resolve()):
                    raise ValueError("Unsafe package member")
                data = archive.extractfile(member).read()
                provenance = {}
                if group == "tesseract-core" and name.endswith(".wasm"):
                    provenance = {"sourcePath": name, "sourceBytes": len(data),
                                  "sourceSha256": hashlib.sha256(data).hexdigest(),
                                  "encoding": "gzip"}
                    # GzipFile fixes the timestamp, filename and OS header for reproducible bytes.
                    buffer = io.BytesIO()
                    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0, compresslevel=9) as stream:
                        stream.write(data)
                    data = buffer.getvalue()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                files.append({"path": f"{group}/{relative}", "bytes": len(data),
                              "sha256": hashlib.sha256(data).hexdigest(), **provenance})
        if group == "tessdata":
            # The npm archive omits the upstream traineddata repository license.
            license_url = "https://raw.githubusercontent.com/naptha/tessdata/gh-pages/LICENSE"
            with urllib.request.urlopen(license_url, timeout=30) as response:
                data = response.read(100_000)
            digest = hashlib.sha256(data).hexdigest()
            if digest != "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4":
                raise ValueError("Traineddata license changed; review before updating")
            (ROOT / group / "LICENSE").write_bytes(data)
            files.append({"path": "tessdata/LICENSE", "bytes": len(data), "sha256": digest, "source": license_url})
        inventory.append({"package": package, "version": version, "url": url, "integrity": "sha512-" + integrity, "files": files})
        print(f"Bundled {package}@{version}: {len(files)} files, {sum(item['bytes'] for item in files)} bytes", flush=True)
    selected = {entry["path"] for package in inventory for entry in package["files"]}
    for package in previous:
        for entry in package["files"]:
            if entry["path"] not in selected:
                obsolete = (ROOT / entry["path"]).resolve()
                if not obsolete.is_relative_to(ROOT.resolve()):
                    raise ValueError("Unsafe obsolete inventory path")
                obsolete.unlink(missing_ok=True)
    (ROOT / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
