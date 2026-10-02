"""Build a traceable synthetic bootstrap corpus using the real TXT extractor.

Run from the repository root: python -m training.prepare_dataset
Existing output directories are never overwritten. No network or Drive access.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import random
import shutil
import textwrap
from collections import Counter
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from app.extractors import extract_document
from training.synthetic_documents import DISCLAIMER, generate_documents
from training.validate_dataset import validate_dataset

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "local:training/synthetic_documents.py"
SPLITS = ("train", "validation", "test", "challenge")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def group_splits(groups: list[str], seed: int) -> dict[str, str]:
    """Keep whole template families together, with at least two holdout families."""
    unique = sorted(set(groups))
    if len(unique) < 5:
        raise ValueError("Need at least five template families for three meaningful splits.")
    random.Random(seed).shuffle(unique)
    validation_count = max(1, len(unique) // 5)
    test_count = max(1, len(unique) // 5)
    mapping = {}
    for index, group in enumerate(unique):
        mapping[group] = (
            "test"
            if index < test_count
            else "validation"
            if index < test_count + validation_count
            else "train"
        )
    return mapping


def export_text(document: dict, output: Path, split: str) -> dict:
    """Persist the original and provenance, extracting through Milestone 2."""
    doc_id = document["document_id"]
    original = output / "originals" / f"{doc_id}.txt"
    original.write_text(document["text"], encoding="utf-8", newline="\n")
    result = extract_document(original)
    if result.status != "extracted":
        raise ValueError(f"Synthetic extraction did not succeed: {doc_id}: {result.status}")
    write_json(output / "extractions" / f"{doc_id}.json", result.model_dump(mode="json"))
    record = {
        **document,
        "schema_version": 1,
        "text": result.text,
        "text_sha256": sha256(result.text.encode("utf-8")),
        "original_sha256": sha256(original.read_bytes()),
        "original_path": original.relative_to(output).as_posix(),
        "extraction_path": f"extractions/{doc_id}.json",
        "file_type": "txt",
        "extraction_status": result.status,
        "extractor": result.extractor,
        "extractor_version": result.extractor_version,
        "text_origin": "filewise_extractor",
        "source_url": SOURCE_URL,
        "license": "LicenseRef-Filewise-Synthetic",
        "license_url": "sources.json#filewise_synthetic_v1",
        "split": split,
    }
    return record


def render_ocr_pair(record: dict, output: Path) -> list[dict]:
    """Render paired clear/degraded scans; these are NOT actual OCR outputs."""
    font = ImageFont.load_default(size=19)
    lines = []
    for paragraph in record["text"].splitlines():
        lines.extend(textwrap.wrap(paragraph, width=84) or [""])
    width, line_height = 1240, 29
    height = max(1754, 100 + len(lines) * line_height)
    clear = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(clear)
    for index, line in enumerate(lines):
        draw.text((55, 40 + index * line_height), line, font=font, fill="black")
    # Rotation plus mild blur/downsampling is a simulated scan, not real phone capture.
    degraded = clear.resize((width * 3 // 4, height * 3 // 4)).resize(clear.size)
    degraded = degraded.rotate(1.2, expand=True, fillcolor="white")
    degraded = degraded.filter(ImageFilter.GaussianBlur(0.55))
    rows = []
    for variant, image in (("clear", clear), ("degraded", degraded)):
        path = output / "ocr_pending" / f"{record['document_id']}-{variant}.png"
        image.save(path)
        rows.append(
            {
                "document_id": f"{record['document_id']}-{variant}",
                "parent_document_id": record["document_id"],
                "label": record["label"],
                "category": record["category"],
                "group_id": record["group_id"],
                "split": record["split"],
                "is_synthetic": True,
                "language": "en",
                "variant": variant,
                "original_path": path.relative_to(output).as_posix(),
                "original_sha256": sha256(path.read_bytes()),
                "expected_text": record["text"],
                "text": None,
                "text_origin": "ground_truth_only_not_ocr",
                "extraction_status": "needs_ocr",
                "training_eligible": False,
                "source_id": record["source_id"],
                "license": record["license"],
            }
        )
    return rows


def challenge_documents() -> list[dict]:
    """Small explicit out-of-scope set; not a learned miscellaneous class."""
    examples = [
        (
            "Meeting notes",
            (
                "The team discussed accessibility and navigation. Mira will prepare "
                "a prototype. The next review will compare search filters and keyboard navigation."
            ),
        ),
        (
            "Garden diary",
            (
                "Two basil seedlings were moved into larger pots. The soil remained "
                "damp after rain. New leaves appeared near the sunny window."
            ),
        ),
        (
            "Travel itinerary",
            (
                "Arrive at the fictional Cedar station on Friday. Visit the "
                "museum on Saturday and return Sunday. This is a plan, not a ticket or payment record."
            ),
        ),
        (
            "Book review",
            (
                "The novel follows two friends repairing a lighthouse. Its alternating "
                "narrators describe the same events differently. The final chapter resolves the mystery."
            ),
        ),
        (
            "Software notes",
            (
                "The parser accepts UTF-8 text and reports decoding failures. "
                "The next change will improve timeout handling and add structured logging."
            ),
        ),
        (
            "Packing checklist",
            (
                "Pack a reusable bottle, notebook, raincoat and charger. "
                "Check the weather forecast before leaving and keep spare socks in a small bag."
            ),
        ),
        (
            "Workshop agenda",
            (
                "Opening discussion, followed by a drawing activity and a break. "
                "Participants will share their sketches. This agenda does not certify attendance."
            ),
        ),
        (
            "Product catalogue",
            (
                "Desk lamp: adjustable arm, warm light and a metal base. "
                "Storage tray: three compartments. No purchase, payment or amount due is recorded."
            ),
        ),
        (
            "Property advertisement",
            (
                "A fictional garden plot is advertised near a walking path. "
                "Interested readers may request further details. This advertisement records no title "
                "or ownership transfer."
            ),
        ),
        (
            "School timetable",
            (
                "Monday: English, Mathematics and Art. Tuesday: Science and "
                "History. Lunch is at noon. This schedule contains no examination results."
            ),
        ),
        (
            "Clinic opening hours",
            (
                "The sample clinic is open from nine until five on weekdays. "
                "Visitors should arrange an appointment. No patient consultation is recorded."
            ),
        ),
        (
            "Budget plan",
            (
                "Planned monthly spending: groceries 4000, transport 1500, books 800. "
                "These are estimates rather than bank transactions or paid purchases."
            ),
        ),
    ]
    return [
        {
            "document_id": sha256(f"challenge-v1-{i}".encode())[:24],
            "label": None,
            "category": None,
            "text": f"{DISCLAIMER}\n\n{title}\n\n{body}\n",
            "group_id": f"challenge_family_{i:02d}",
            "template_id": f"challenge_{i:02d}",
            "language": "en",
            "is_synthetic": True,
            "review_status": "synthetic_rule_labeled",
            "source_id": "filewise_synthetic_v1",
            "expected_action": "needs_review",
        }
        for i, (title, body) in enumerate(examples)
    ]


def attach_public_reference(cache: Path, output: Path) -> dict:
    """Copy the verified CORD cache without mixing publisher text into model splits."""
    cache = cache.resolve()
    records = [
        json.loads(line)
        for line in (cache / "public_records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    target = output / "public_reference"
    target.mkdir()
    for folder in ("images", "annotations"):
        (target / folder).mkdir()
    for record in records:
        for field, hash_field, folder in (
            ("original_path", "sha256", "images"),
            ("annotation_path", "annotation_sha256", "annotations"),
        ):
            source = (ROOT / record[field]).resolve()
            if not source.is_relative_to(cache):
                raise ValueError(
                    f"Public cache path escapes its directory: {record['document_id']}"
                )
            if sha256(source.read_bytes()) != record[hash_field]:
                raise ValueError(f"Public cache checksum mismatch: {record['document_id']}")
            destination = target / folder / source.name
            shutil.copyfile(source, destination)
            record[field] = destination.relative_to(output).as_posix()
        if sha256(record["text"].encode("utf-8")) != record["text_sha256"]:
            raise ValueError(f"Public annotation text checksum mismatch: {record['document_id']}")
        record["training_eligible"] = False
        record["split"] = "reference"
    write_jsonl(target / "public_records.jsonl", records)
    for name in (
        "LICENSE-CC-BY.txt",
        "ATTRIBUTION.txt",
        "download_report.json",
        "PUBLISHER-README.txt",
        "dataset_infos.json",
    ):
        source = cache / "cord-v2" / name
        if source.is_file():
            shutil.copyfile(source, target / name)
    # Attribution is required, so fail instead of silently creating an unlicensed subset.
    if not (target / "LICENSE-CC-BY.txt").is_file():
        raise ValueError("Public source cache is missing the publisher license")
    (target / "ATTRIBUTION.txt").write_text(
        "CORD: A Consolidated Receipt Dataset for Post-OCR Parsing\n"
        "Park et al., NAVER CLOVA, 2019\n"
        "Source: https://github.com/clovaai/cord\n"
        "Official dataset: https://huggingface.co/datasets/naver-clova-ix/cord-v2\n"
        "License: Creative Commons Attribution 4.0 International (CC-BY-4.0).\n"
        "See LICENSE-CC-BY.txt. No endorsement by the original authors is implied.\n"
        "Changes: selected 75 validation and 75 test rows; saved publisher-viewer JPEGs;\n"
        "joined selected annotated words into lines; added local IDs, hashes and provenance.\n"
        "These annotations are selected fields, not complete page text or Filewise OCR.\n",
        encoding="utf-8",
    )
    write_json(
        target / "checksums.json",
        {
            path.relative_to(target).as_posix(): sha256(path.read_bytes())
            for path in sorted(target.rglob("*"))
            if path.is_file()
        },
    )
    return {
        "documents": len(records),
        "training_eligible": False,
        "source_id": "naver-clova-ix/cord-v2",
        "source_cache_manifest_sha256": sha256((cache / "public_records.jsonl").read_bytes()),
        "purpose": "Separate real receipt OCR reference, not an eight-class test set",
    }


def write_preview(output: Path, rows: list[dict], config: dict) -> None:
    """Local, script-free browser index; all dataset text is HTML-escaped."""
    sections = []
    for label in sorted({row["label"] for row in rows if row["label"]}):
        examples = [row for row in rows if row["label"] == label]
        items, seen = [], set()
        for row in examples:
            if row["template_id"] in seen:
                continue
            seen.add(row["template_id"])
            items.append(
                f"<details><summary>{html.escape(row['template_id'])} "
                f"({html.escape(row['split'])})</summary>"
                f'<a href="{html.escape(row["original_path"], quote=True)}">Open TXT original</a>'
                f"<pre>{html.escape(row['text'])}</pre></details>"
            )
        sections.append(
            f"<section><h2>{html.escape(label.replace('_', ' ').title())}</h2>"
            f"<p>{len(examples)} synthetic documents; {len(seen)} templates</p>"
            + "".join(items)
            + "</section>"
        )
    body = """<!doctype html><html lang="en"><meta charset="utf-8">
<title>Filewise dataset preview</title><style>
body{font:16px system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;
color:#172337;background:#f6f8fb}section{background:white;padding:20px;margin:20px 0;
border:1px solid #d6dfea;border-radius:8px}details{padding:12px 0;border-top:1px solid #eee}
summary{cursor:pointer}pre{white-space:pre-wrap;line-height:1.6;font-size:14px}
a{color:#144fb2}.notice{padding:18px;background:#fff1ce;border-radius:8px}</style>
<h1>Filewise document dataset</h1><p class="notice">Synthetic bootstrap dataset.
No production accuracy claim. Public receipts and images awaiting OCR are separate.
Expand an example to inspect its content. All people and records below are fictional.</p>
<p><a href="labels.csv">Labels CSV</a> &middot;
<a href="build_config.json">Build details and limitations</a> &middot;
<a href="validation_report.json">Validation report</a></p>"""
    counts = html.escape(json.dumps(config["counts_by_split"]))
    body += f"<p>Document counts: {counts}</p>" + "".join(sections) + "</html>"
    (output / "preview.html").write_text(body, encoding="utf-8")


def build_dataset(
    output: Path,
    *,
    seed: int = 42,
    per_template: int = 20,
    include_images: bool = True,
    public_cache: Path | None = None,
) -> dict:
    if per_template < 1:
        raise ValueError("per_template must be positive")
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing dataset: {output}")
    documents = list(generate_documents(seed=seed, per_template=per_template))
    assignments = group_splits([doc["group_id"] for doc in documents], seed)
    output.mkdir(parents=True)
    for folder in ("originals", "extractions", "ocr_pending"):
        (output / folder).mkdir()
    write_json(output / "BUILD_IN_PROGRESS.json", {"seed": seed, "per_template": per_template})
    shutil.copyfile(ROOT / "training" / "categories.json", output / "categories.json")
    rows, images, seen_templates = [], [], set()
    for document in documents:
        record = export_text(document, output, assignments[document["group_id"]])
        rows.append(record)
        template = (record["label"], record["template_id"])
        if include_images and template not in seen_templates:
            images.extend(render_ocr_pair(record, output))
            seen_templates.add(template)
    rows.extend(export_text(doc, output, "challenge") for doc in challenge_documents())
    write_jsonl(output / "manifest.jsonl", rows)
    for split in SPLITS:
        write_jsonl(output / f"{split}.jsonl", [row for row in rows if row["split"] == split])
    write_jsonl(output / "ocr_pending.jsonl", images)
    with (output / "labels.csv").open("x", encoding="utf-8", newline="") as stream:
        columns = [
            "document_id",
            "label",
            "category",
            "group_id",
            "template_id",
            "split",
            "language",
            "is_synthetic",
            "review_status",
            "original_path",
            "source_id",
        ]
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    generator_files = [
        "training/synthetic_documents.py",
        "training/categories.json",
        "training/prepare_dataset.py",
        "training/validate_dataset.py",
        "training/check_artifacts.py",
        "app/extractors/service.py",
        "app/extractors/txt.py",
        "app/extractors/models.py",
    ]
    write_json(
        output / "sources.json",
        [
            {
                "source_id": "filewise_synthetic_v1",
                "source_url": SOURCE_URL,
                "license": "LicenseRef-Filewise-Synthetic",
                "license_note": "Fictional examples generated within this project at the user's request; "
                "no third-party originals copied. This identifier is provenance, "
                "not an assertion of a third-party open-source license.",
                "is_synthetic": True,
                "language": "en",
            }
        ],
    )
    config = {
        "dataset_version": "filewise-bootstrap-v1",
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "seed": seed,
        "per_template": per_template,
        "template_group_assignments": assignments,
        "counts_by_split": dict(Counter(row["split"] for row in rows)),
        "counts_by_label": dict(Counter(row["label"] for row in rows if row["label"])),
        "ocr_pending_images": len(images),
        "production_ready": False,
        "dependencies": {pkg: version(pkg) for pkg in ("Pillow", "pydantic", "pdfminer.six")},
        "generator_sha256": {name: sha256((ROOT / name).read_bytes()) for name in generator_files},
        "reproducibility": "Same generator, config and dependencies reproduce document text, "
        "IDs, split assignments and images. Extraction timestamps differ.",
        "limitations": [
            "All main split documents are synthetic English examples, not independent real samples.",
            "Shared generator vocabulary remains across held-out template groups.",
            "Synthetic test scores measure generator generalization, not deployed accuracy.",
            "Image ground truth is not actual OCR text; images are excluded from training splits.",
            "Land records are fictional generic forms, not regional legal representations.",
            "Prescription samples omit real medication and dosage information.",
            "No real multiclass benchmark; public receipts are a separate OCR reference corpus.",
        ],
    }
    if public_cache is not None:
        config["public_reference"] = attach_public_reference(public_cache, output)
    write_json(output / "build_config.json", config)
    write_preview(output, rows, config)
    write_json(
        output / "checksums.json",
        {
            name: sha256((output / name).read_bytes())
            for name in (
                "manifest.jsonl",
                "train.jsonl",
                "validation.jsonl",
                "test.jsonl",
                "challenge.jsonl",
                "ocr_pending.jsonl",
                "categories.json",
                "labels.csv",
                "sources.json",
            )
        },
    )
    (output / "BUILD_IN_PROGRESS.json").unlink()
    report = validate_dataset(output)
    write_json(output / "validation_report.json", report)
    if report["errors"]:
        raise ValueError(f"Dataset validation failed; inspect {output / 'validation_report.json'}")
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "storage/datasets/filewise-v1")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--per-template", type=int, default=20)
    parser.add_argument("--no-images", action="store_true")
    parser.add_argument(
        "--public-cache",
        type=Path,
        help="Optional verified public receipt cache; stays separate from splits",
    )
    args = parser.parse_args()
    config = build_dataset(
        args.output,
        seed=args.seed,
        per_template=args.per_template,
        include_images=not args.no_images,
        public_cache=args.public_cache,
    )
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "counts": config["counts_by_split"],
                "ocr_pending_images": config["ocr_pending_images"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
