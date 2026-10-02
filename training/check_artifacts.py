"""Verify optional image/annotation collections without treating them as training rows."""

import hashlib
import json
from collections import defaultdict
from pathlib import Path, PureWindowsPath

from PIL import Image


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file(directory: Path, relative: str) -> Path:
    if not isinstance(relative, str):
        raise TypeError("Artifact path must be a string")
    windows = PureWindowsPath(relative)
    if windows.drive or windows.root or ".." in windows.parts:
        raise ValueError("Artifact path must be relative to the dataset")
    path = (directory / relative).resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError("Artifact path escapes dataset")
    return path


def _rows(path: Path) -> list[dict]:
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


def check_artifacts(directory: Path, manifest: list[dict]) -> dict:
    errors = []
    parents = {
        row["document_id"]: row for row in manifest if isinstance(row.get("document_id"), str)
    }
    image_count = public_count = 0
    public_groups = defaultdict(list)
    identifiers = set(parents)
    pending = directory / "ocr_pending.jsonl"
    reference = directory / "public_reference/public_records.jsonl"
    try:
        for row in _rows(pending) if pending.is_file() else []:
            identifier = row["document_id"]
            if identifier in identifiers:
                raise ValueError(f"Repeated image/reference ID: {identifier}")
            identifiers.add(identifier)
            parent = parents[row["parent_document_id"]]
            for field in ("label", "category", "group_id", "split", "source_id", "license"):
                if row[field] != parent[field]:
                    raise ValueError(f"OCR image {identifier}: parent {field} mismatch")
            if (
                row["expected_text"] != parent["text"]
                or row["text"] is not None
                or row["training_eligible"] is not False
                or row["extraction_status"] != "needs_ocr"
                or row["text_origin"] != "ground_truth_only_not_ocr"
            ):
                raise ValueError(f"OCR image {identifier}: ground truth is incorrectly represented")
            path = _file(directory, row["original_path"])
            if _digest(path.read_bytes()) != row["original_sha256"]:
                raise ValueError(f"OCR image {identifier}: checksum mismatch")
            with Image.open(path) as image:
                image.verify()
            image_count += 1

        for row in _rows(reference) if reference.is_file() else []:
            identifier = row["document_id"]
            if identifier in identifiers:
                raise ValueError(f"Repeated image/reference ID: {identifier}")
            identifiers.add(identifier)
            if (
                row["split"] != "reference"
                or row["training_eligible"] is not False
                or row["is_synthetic"] is not False
                or row["ocr_executed"] is not False
                or row["text_origin"] != "publisher_ocr_annotation"
            ):
                raise ValueError(f"Public record {identifier}: incorrect training/OCR provenance")
            original = _file(directory, row["original_path"])
            annotation_path = _file(directory, row["annotation_path"])
            if (
                _digest(original.read_bytes()) != row["sha256"]
                or _digest(annotation_path.read_bytes()) != row["annotation_sha256"]
            ):
                raise ValueError(
                    f"Public record {identifier}: original/annotation checksum mismatch"
                )
            annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
            lines = []
            for line in annotation["valid_line"]:
                words = [str(word.get("text", "")) for word in line.get("words", [])]
                text = " ".join(word for word in words if word).strip()
                if text:
                    lines.append(text)
            if (
                row["text"] != "\n".join(lines)
                or _digest(row["text"].encode("utf-8")) != row["text_sha256"]
            ):
                raise ValueError(
                    f"Public record {identifier}: text differs from publisher annotation"
                )
            with Image.open(original) as image:
                image.verify()
            public_groups[row["text_sha256"]].append(
                {
                    "document_id": identifier,
                    "original_split": row["original_split"],
                    "group_id": row["group_id"],
                }
            )
            public_count += 1
        if reference.is_file():
            checksums = json.loads(
                (reference.parent / "checksums.json").read_text(encoding="utf-8")
            )
            for name, expected in checksums.items():
                if _digest(_file(reference.parent, name).read_bytes()) != expected:
                    raise ValueError(f"Public reference checksum mismatch: {name}")
            for name in ("LICENSE-CC-BY.txt", "ATTRIBUTION.txt"):
                if not (reference.parent / name).is_file():
                    raise ValueError(f"Missing public source license/attribution: {name}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        errors.append(f"Optional artifact validation: {error}")
    duplicates = [group for group in public_groups.values() if len(group) > 1]
    for group in duplicates:
        if len({row["group_id"] for row in group}) != 1:
            errors.append("Repeated public annotation text must share a conservative group ID")
    return {
        "errors": errors,
        "verified_pending_ocr_images": image_count,
        "verified_public_reference_records": public_count,
        "public_annotation_duplicate_groups": duplicates,
        "note": "Public reference and pending OCR images remain outside model training splits.",
    }
