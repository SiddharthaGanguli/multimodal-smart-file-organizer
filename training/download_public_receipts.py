"""Cache a small, attributed CORD v2 reference subset from its official release.

Network opt-in utility, not called by the normal dataset build. Ground truth is
publisher annotation, NOT the result of Filewise OCR. No credentials are used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / "storage" / "datasets" / "source-cache"
SOURCE_ID = "naver-clova-ix/cord-v2"
REVISION = "7f0115a4b758a71d6473b8d085751692da2fef98"
LICENSE_URL = "https://github.com/clovaai/cord/blob/master/LICENSE-CC-BY"
COUNTS = {"validation": 75, "test": 75}
CACHED_RECORDS: dict[str, dict] = {}


def fetch(url: str) -> bytes:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {
        "huggingface.co", "datasets-server.huggingface.co", "raw.githubusercontent.com"
    }:
        raise ValueError("Only HTTPS URLs on the allowlisted publisher hosts are permitted")
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"User-Agent": "Filewise-dataset-preparation/1.0"}), timeout=45) as response:
                result = response.read(25 * 1024 * 1024 + 1)
            if len(result) > 25 * 1024 * 1024:
                raise ValueError("Unexpectedly large individual source download")
            return result
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("Unreachable")


def save(path: Path, data: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def annotation_text(annotation: dict) -> str:
    # Preserve publisher sequence within each line. Valid lines cover selected
    # semantic fields, not all text visible in the image.
    lines = []
    for line in annotation.get("valid_line", []):
        words = [str(word.get("text", "")) for word in line.get("words", [])]
        text = " ".join(word for word in words if word).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def download_row(item: tuple[str, dict]) -> dict:
    split, entry = item
    index = entry["row_idx"]
    row = entry["row"]
    image_url = row["image"]["src"]
    if f"/--/{REVISION}/--/" not in image_url:
        raise ValueError("Viewer image revision differs from pinned official dataset revision")
    annotation = json.loads(row["ground_truth"])
    annotation_split = annotation.get("meta", {}).get("split")
    accepted_split_names = {"validation": {"dev", "valid", "validation"}}.get(split, {split})
    if annotation_split not in accepted_split_names:
        raise ValueError(f"Split metadata mismatch: {split} vs {annotation_split}")
    document_id = f"cord-v2-{split}-{index:04d}"
    image_path = ROOT / "cord-v2" / "images" / f"{document_id}.jpg"
    annotation_path = ROOT / "cord-v2" / "annotations" / f"{document_id}.json"
    cached_record = CACHED_RECORDS.get(document_id, {})
    image_data = image_path.read_bytes() if image_path.is_file() else b""
    if (
        not image_data
        or cached_record.get("source_revision") != REVISION
        or hashlib.sha256(image_data).hexdigest() != cached_record.get("sha256")
    ):
        image_data = fetch(image_url)
    if not image_data.startswith(b"\xff\xd8"):
        raise ValueError("Expected a JPEG image from the official viewer")
    image_sha = save(image_path, image_data)
    annotation_bytes = (json.dumps(annotation, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    annotation_sha = save(annotation_path, annotation_bytes)
    text = annotation_text(annotation)
    if not text:
        raise ValueError("Empty annotation text")
    return {
        "document_id": document_id,
        "label": "receipt",
        "category": "bills_payments",
        "text": text,
        "text_origin": "publisher_ocr_annotation",
        "text_coverage": "selected_valid_line_fields_not_full_page",
        "language": "id",
        "language_basis": "publisher_describes_Indonesian_receipts; may_contain_English_terms",
        "source_id": SOURCE_ID,
        "source_revision": REVISION,
        "source_url": f"https://huggingface.co/datasets/{SOURCE_ID}/tree/{REVISION}",
        "source_row_index": index,
        "source_image_id": annotation.get("meta", {}).get("image_id"),
        "license": "CC-BY-4.0",
        "license_url": LICENSE_URL,
        "attribution": "CORD: A Consolidated Receipt Dataset for Post-OCR Parsing; Park et al., NAVER CLOVA, 2019",
        "modifications": "Subset selection; valid_line word transcriptions joined with spaces and newlines; local IDs and metadata added. Image is the publisher-hosted dataset-viewer JPEG representation.",
        "group_id": document_id,
        "merchant_group_id": None,
        "grouping_limitations": "Exact annotation text duplicates share a group; merchant/template groups are not supplied in the public annotations. Keep this source separate from model-development splits.",
        "original_split": split,
        "publisher_annotation_split": annotation_split,
        "is_synthetic": False,
        "review_status": "publisher_annotations_not_individually_human_reviewed_here",
        "label_provenance": "publisher_receipt_dataset_definition",
        "label_confidence": "source_level_not_individual_manual_review",
        "recommended_use": "separate_real_receipt_reference_not_eight_class_accuracy_benchmark",
        "original_path": image_path.relative_to(REPO).as_posix(),
        "original_representation": "publisher_dataset_viewer_jpeg",
        "annotation_path": annotation_path.relative_to(REPO).as_posix(),
        "sha256": image_sha,
        "annotation_sha256": annotation_sha,
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "extraction_status": "needs_ocr",
        "ocr_executed": False,
    }


def group_exact_annotation_duplicates(records: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for record in records:
        groups.setdefault(record["text_sha256"], []).append(record)
        record["group_id"] = f"cord-v2-text-{record['text_sha256'][:16]}"
        record["grouping_limitations"] = (
            "Exact annotation text duplicates share a group; merchant/template "
            "groups are not supplied in the public annotations. Keep this source "
            "separate from model-development splits."
        )
    return [
        {
            "group_id": members[0]["group_id"],
            "document_ids": [record["document_id"] for record in members],
            "original_splits": sorted({record["original_split"] for record in members}),
            "crosses_publisher_splits": len({record["original_split"] for record in members}) > 1,
        }
        for members in groups.values() if len(members) > 1
    ]


def verify_cache() -> dict:
    from PIL import Image

    records_path = ROOT / "public_records.jsonl"
    records = [json.loads(line) for line in records_path.read_text(encoding="utf-8").splitlines()]
    if len(records) != sum(COUNTS.values()):
        raise ValueError("Cached record count differs from the pinned subset size")
    if len({record["document_id"] for record in records}) != len(records):
        raise ValueError("Duplicate document IDs")
    for split, count in COUNTS.items():
        if sum(record["original_split"] == split for record in records) != count:
            raise ValueError("Cached publisher split counts differ from the pinned subset")
    for record in records:
        if record["source_revision"] != REVISION or record["text_origin"] != "publisher_ocr_annotation":
            raise ValueError("Unexpected revision or text provenance")
        for field, hash_field in [("original_path", "sha256"), ("annotation_path", "annotation_sha256")]:
            path = (REPO / record[field]).resolve()
            if not path.is_relative_to(ROOT.resolve()):
                raise ValueError("Cache path escapes the expected cache directory")
            if hashlib.sha256(path.read_bytes()).hexdigest() != record[hash_field]:
                raise ValueError(f"Checksum mismatch for {record['document_id']} {field}")
        with Image.open(REPO / record["original_path"]) as image:
            image.verify()
        annotation = json.loads((REPO / record["annotation_path"]).read_text(encoding="utf-8"))
        if annotation_text(annotation) != record["text"]:
            raise ValueError("Cached annotation/text mismatch")
        if hashlib.sha256(record["text"].encode("utf-8")).hexdigest() != record["text_sha256"]:
            raise ValueError("Text checksum mismatch")
        if record["group_id"] != f"cord-v2-text-{record['text_sha256'][:16]}":
            raise ValueError("Exact duplicate annotation grouping was not retained")
    download_report = json.loads((ROOT / "cord-v2" / "download_report.json").read_text(encoding="utf-8"))
    for filename, field in [("LICENSE-CC-BY.txt", "license_sha256"), ("PUBLISHER-README.txt", "publisher_readme_sha256")]:
        actual_sha = hashlib.sha256((ROOT / "cord-v2" / filename).read_bytes()).hexdigest()
        if actual_sha != download_report[field]:
            raise ValueError("Cached publisher license/README checksum mismatch")
    duplicate_groups = group_exact_annotation_duplicates(records)
    return {
        "verified_records": len(records),
        "verified_image_and_annotation_checksums": len(records) * 2,
        "verified_image_decodes": len(records),
        "ocr_executed": False,
        "duplicate_annotation_groups": duplicate_groups,
        "all_records_remain_reference_only": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Check cached records and hashes without network access")
    args = parser.parse_args()
    if args.verify_only:
        print(json.dumps(verify_cache(), indent=2))
        return
    existing_records = ROOT / "public_records.jsonl"
    if existing_records.exists():
        for line in existing_records.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            CACHED_RECORDS[record["document_id"]] = record
    metadata = json.loads(fetch(f"https://huggingface.co/api/datasets/{SOURCE_ID}"))
    if metadata["sha"] != REVISION:
        raise ValueError("Official dataset revision changed; re-review and pin explicitly before downloading")
    license_bytes = fetch("https://raw.githubusercontent.com/clovaai/cord/master/LICENSE-CC-BY")
    readme_bytes = fetch("https://raw.githubusercontent.com/clovaai/cord/master/README.md")
    save(ROOT / "cord-v2" / "LICENSE-CC-BY.txt", license_bytes)
    save(ROOT / "cord-v2" / "PUBLISHER-README.txt", readme_bytes)
    rows = []
    for split, count in COUNTS.items():
        query = urlencode({"dataset": SOURCE_ID, "config": "default", "split": split, "offset": 0, "length": count})
        payload = json.loads(fetch(f"https://datasets-server.huggingface.co/rows?{query}"))
        if len(payload["rows"]) != count:
            raise ValueError("Incomplete rows response")
        rows.extend((split, row) for row in payload["rows"])
    records = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for record in pool.map(download_row, rows):
            records.append(record)
            if len(records) % 25 == 0:
                print(f"Cached {len(records)} / {len(rows)} CORD records", flush=True)
    duplicate_groups = group_exact_annotation_duplicates(records)
    output = ROOT / "public_records.jsonl"
    output.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    report = {
        "source_id": SOURCE_ID,
        "source_revision": REVISION,
        "downloaded_records": len(records),
        "selection": "First 75 official validation rows and first 75 official test rows; deterministic convenience subset, not a statistically representative sample. Training-viewer download was unavailable because its parquet scan exceeds the service limit.",
        "original_split_counts": COUNTS,
        "output": output.relative_to(REPO).as_posix(),
        "duplicate_image_hashes": len(records) - len({r["sha256"] for r in records}),
        "duplicate_annotation_texts": len(records) - len({r["text_sha256"] for r in records}),
        "duplicate_annotation_groups": duplicate_groups,
        "license_sha256": hashlib.sha256(license_bytes).hexdigest(),
        "publisher_readme_sha256": hashlib.sha256(readme_bytes).hexdigest(),
        "text_origin": "publisher_ocr_annotation",
        "ocr_executed": False,
    }
    (ROOT / "cord-v2" / "download_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
