"""Validate the dataset manifest, exports, provenance, and split isolation.

Run ``python -m training.validate_dataset storage/datasets/v1``. Passing this
validator means the dataset is structurally usable, not that a model is accurate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path, PureWindowsPath

from training.check_artifacts import check_artifacts

SPLITS = ("train", "validation", "test", "challenge")
EXTRACTION_STATUSES = {"extracted", "needs_ocr", "failed", "empty"}
TEXT_ORIGINS = {"filewise_extractor", "publisher_ocr_annotation"}
REQUIRED_STRINGS = (
    "document_id",
    "group_id",
    "source_id",
    "source_url",
    "license",
    "license_url",
    "language",
    "review_status",
    "split",
    "extraction_status",
    "text_origin",
)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_jsonl(path: Path, errors: list[str]) -> list[dict]:
    records = []
    try:
        with path.open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                where = f"{path.name}:{line_number}"
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    errors.append(f"{where}: invalid JSON ({error.msg})")
                    continue
                if not isinstance(record, dict):
                    errors.append(f"{where}: record must be an object")
                    continue
                records.append(record)
    except (OSError, UnicodeError) as error:
        errors.append(f"Cannot read {path.name}: {error}")
    return records


def _categories(directory: Path, errors: list[str]) -> dict[str, str]:
    path = directory / "categories.json"
    if not path.exists():
        path = Path(__file__).with_name("categories.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {item["label"]: item["category"] for item in data["categories"]}
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        errors.append(f"Cannot read category definitions: {error}")
        return {}


def _inside_dataset(directory: Path, name: str) -> Path:
    """Resolve a relative local path without allowing absolute paths or traversal."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("path must be a nonempty string")
    windows_path = PureWindowsPath(name)
    path = Path(name)
    if path.is_absolute() or windows_path.drive or ".." in windows_path.parts:
        raise ValueError("path must stay inside the dataset directory")
    resolved = (directory / path).resolve()
    if not resolved.is_relative_to(directory):
        raise ValueError("path resolves outside the dataset directory")
    return resolved


def _check_original(record: dict, directory: Path, where: str, errors: list[str]) -> None:
    original_path = record.get("original_path")
    original_hash = record.get("original_sha256")
    if original_path is None:
        if original_hash is not None:
            errors.append(f"{where}: original_sha256 requires original_path")
        return
    if not isinstance(original_path, str) or not original_path.strip():
        errors.append(f"{where}: original_path must be a nonempty relative path or null")
        return
    try:
        resolved = _inside_dataset(directory, original_path)
    except (OSError, ValueError) as error:
        errors.append(f"{where}: invalid original_path ({error})")
        return
    if not isinstance(original_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", original_hash):
        errors.append(f"{where}: original_sha256 must be a lowercase SHA256 digest")
        return
    try:
        with resolved.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != original_hash:
            errors.append(f"{where}: original_sha256 does not match original file")
    except (OSError, ValueError) as error:
        errors.append(f"{where}: cannot read original file ({error})")


def _check_record(
    record: dict, directory: Path, categories: dict[str, str], where: str, errors: list[str]
) -> None:
    for field in ("label", "category", "text", "text_sha256", "original_sha256"):
        if field not in record:
            errors.append(f"{where}: missing required field {field}")
    for field in REQUIRED_STRINGS:
        if not isinstance(record.get(field), str) or not record[field].strip():
            errors.append(f"{where}: {field} must be a nonempty string")
    if not isinstance(record.get("is_synthetic"), bool):
        errors.append(f"{where}: is_synthetic must be a boolean")
    if record.get("split") not in SPLITS:
        errors.append(f"{where}: split must be one of {SPLITS}")
    if (
        not isinstance(record.get("extraction_status"), str)
        or record["extraction_status"] not in EXTRACTION_STATUSES
    ):
        errors.append(f"{where}: invalid extraction_status")
    if not isinstance(record.get("text_origin"), str) or record["text_origin"] not in TEXT_ORIGINS:
        errors.append(f"{where}: invalid text_origin")
    for field in ("extractor", "extractor_version"):
        if field not in record or (
            record[field] is not None and not isinstance(record[field], str)
        ):
            errors.append(f"{where}: {field} must be a string or null")
        if (
            record.get("text_origin") == "filewise_extractor"
            and record.get("extraction_status") == "extracted"
            and not record.get(field)
        ):
            errors.append(f"{where}: extracted Filewise text needs {field}")
    if record.get("template_id") is not None and not isinstance(record["template_id"], str):
        errors.append(f"{where}: template_id must be a string or null")

    text = record.get("text")
    if not isinstance(text, str):
        errors.append(f"{where}: text must be a string")
    elif record.get("text_sha256") != _sha256(text):
        errors.append(f"{where}: text_sha256 does not match UTF-8 text")
    if record.get("split") == "challenge":
        if record.get("label") is not None or record.get("category") is not None:
            errors.append(f"{where}: challenge label and category must be null")
    else:
        label = record.get("label")
        if not isinstance(label, str) or label not in categories:
            errors.append(f"{where}: unsupported label")
        elif record.get("category") != categories[label]:
            errors.append(f"{where}: category does not match label {label}")
        if record.get("extraction_status") != "extracted":
            errors.append(f"{where}: model split requires extraction_status=extracted")
        if not isinstance(text, str) or not any(character.isalnum() for character in text):
            errors.append(f"{where}: model split requires usable nonempty text")
    _check_original(record, directory, where, errors)
    if record.get("extraction_path") is not None:
        try:
            path = _inside_dataset(directory, record["extraction_path"])
            extraction = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(extraction, dict):
                raise TypeError("extraction must be a JSON object")
            for field, result_field in (
                ("text", "text"),
                ("extractor", "extractor"),
                ("extractor_version", "extractor_version"),
                ("extraction_status", "status"),
            ):
                if record.get(field) != extraction.get(result_field):
                    errors.append(f"{where}: {field} differs from stored extraction result")
        except (OSError, ValueError, TypeError, UnicodeError) as error:
            errors.append(f"{where}: invalid extraction_path/result ({error})")


def _check_snapshot(directory: Path, errors: list[str]) -> None:
    if (directory / "BUILD_IN_PROGRESS.json").exists():
        errors.append("Dataset build is incomplete: BUILD_IN_PROGRESS.json exists")
    path = directory / "checksums.json"
    if not path.exists():
        return
    try:
        checksums = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(checksums, dict):
            raise TypeError("checksums must be a JSON object")
        for filename, expected in checksums.items():
            try:
                artifact = _inside_dataset(directory, filename)
                with artifact.open("rb") as stream:
                    actual = hashlib.file_digest(stream, "sha256").hexdigest()
                if actual != expected:
                    errors.append(f"checksums.json: checksum mismatch for {filename}")
            except (OSError, ValueError) as error:
                errors.append(f"checksums.json: invalid artifact {filename} ({error})")
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        errors.append(f"Cannot read checksums.json: {error}")


def _split_leakage(records: list[dict], errors: list[str], warnings: list[str]) -> dict:
    counts = {}
    for field in ("group_id", "template_id", "text_sha256", "original_sha256"):
        groups = defaultdict(list)
        for record in records:
            value = record.get(field)
            if isinstance(value, str) and value and (field != "text_sha256" or record.get("text")):
                groups[value].append(record)
        leaked = 0
        duplicates = 0
        for value, members in groups.items():
            splits = {item.get("split") for item in members if isinstance(item.get("split"), str)}
            if len(splits) > 1:
                leaked += 1
                if leaked <= 10:
                    errors.append(f"Cross-split {field} leakage: {value} in {sorted(splits)}")
            elif len(members) > 1 and field.endswith("sha256"):
                duplicates += len(members) - 1
        if leaked > 10:
            errors.append(f"{field}: {leaked - 10} additional cross-split duplicate groups")
        counts[f"{field}_cross_split_groups"] = leaked
        if field.endswith("sha256"):
            counts[f"{field}_within_split_duplicate_records"] = duplicates
            if duplicates:
                warnings.append(f"{duplicates} within-split duplicate records detected by {field}")
    return counts


def _near_duplicates(records: list[dict], threshold: float = 0.85) -> dict:
    """Flag cross-split overlap in five-word shingles; this is not a semantic audit."""
    candidates = []
    shingles = []
    postings = defaultdict(list)
    pairs_found = 0
    for record in records:
        if record.get("split") == "challenge" or not isinstance(record.get("text"), str):
            continue
        words = re.findall(r"\w+", record["text"].casefold())
        if len(words) < 30:
            continue
        current = {tuple(words[index : index + 5]) for index in range(len(words) - 4)}
        if len(current) < 20:
            continue
        intersections = Counter()
        for shingle in current:
            for previous in postings[shingle]:
                other, other_set = shingles[previous]
                if (
                    record.get("split") != other.get("split")
                    and record.get("text_sha256") != other.get("text_sha256")
                    and min(len(current), len(other_set))
                    >= threshold * max(len(current), len(other_set))
                ):
                    intersections[previous] += 1
        for previous, intersection in intersections.items():
            other, other_set = shingles[previous]
            similarity = intersection / (len(current) + len(other_set) - intersection)
            if similarity >= threshold:
                pairs_found += 1
                if len(candidates) < 25:
                    candidates.append(
                        {
                            "document_ids": [other.get("document_id"), record.get("document_id")],
                            "splits": [other.get("split"), record.get("split")],
                            "jaccard": round(similarity, 4),
                        }
                    )
        index = len(shingles)
        shingles.append((record, current))
        for shingle in current:
            postings[shingle].append(index)
    return {
        "method": "casefolded five-word shingles, documents with at least 30 words",
        "jaccard_threshold": threshold,
        "documents_checked": len(shingles),
        "cross_split_candidate_pairs": pairs_found,
        "candidate_sample": candidates,
        "limitation": "Does not prove absence of semantic duplicates or source/template leakage.",
    }


def validate_dataset(directory: Path) -> dict:
    directory = Path(directory).resolve()
    errors: list[str] = []
    warnings: list[str] = []
    categories = _categories(directory, errors)
    _check_snapshot(directory, errors)
    records = _read_jsonl(directory / "manifest.jsonl", errors)
    if not records:
        errors.append("Manifest contains no documents")
    indexed = {}
    for index, record in enumerate(records, 1):
        where = f"manifest.jsonl:{index}"
        _check_record(record, directory, categories, where, errors)
        identifier = record.get("document_id")
        if isinstance(identifier, str):
            if identifier in indexed:
                errors.append(f"{where}: duplicate document_id {identifier}")
            indexed[identifier] = record
    exported = Counter()
    for split in SPLITS:
        for index, record in enumerate(_read_jsonl(directory / f"{split}.jsonl", errors), 1):
            identifier = record.get("document_id")
            where = f"{split}.jsonl:{index}"
            if not isinstance(identifier, str) or identifier not in indexed:
                errors.append(f"{where}: document_id is absent from manifest")
                continue
            exported[identifier] += 1
            if indexed[identifier] != record:
                errors.append(f"{where}: exported record differs from manifest for {identifier}")
            if record.get("split") != split:
                errors.append(f"{where}: record belongs to a different split")
    for identifier in indexed:
        if exported[identifier] != 1:
            errors.append(
                f"{identifier}: expected exactly one split export, found {exported[identifier]}"
            )

    artifacts = check_artifacts(directory, records)
    errors.extend(artifacts["errors"])
    leakage = _split_leakage(records, errors, warnings)
    near_duplicates = _near_duplicates(records)
    if near_duplicates["cross_split_candidate_pairs"]:
        warnings.append("Near-duplicate candidates cross splits; review the candidate sample")
    counters = {}
    for field in ("split", "label", "category", "source_id", "language", "review_status"):
        counters[f"by_{field}"] = dict(
            sorted(Counter(str(record.get(field)) for record in records).items())
        )
    counters["by_split_and_label"] = {
        split: dict(
            sorted(
                Counter(
                    str(record.get("label")) for record in records if record.get("split") == split
                ).items()
            )
        )
        for split in SPLITS
    }
    for split in SPLITS[:3]:
        missing = sorted(set(categories) - set(counters["by_split_and_label"][split]))
        if missing:
            warnings.append(f"{split}: missing supported labels: {', '.join(missing)}")
    synthetic = sum(record.get("is_synthetic") is True for record in records)
    real_test = [
        record
        for record in records
        if record.get("split") == "test" and record.get("is_synthetic") is False
    ]
    if not real_test:
        warnings.append("No real-document test set: synthetic evaluation is a generator smoke test")
    train_labels = counters["by_split_and_label"]["train"]
    return {
        "schema_version": 1,
        "status": "failed" if errors else "passed",
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "documents": len(records),
            "synthetic": synthetic,
            "real": sum(record.get("is_synthetic") is False for record in records),
            "unique_groups": len(
                {
                    record["group_id"]
                    for record in records
                    if isinstance(record.get("group_id"), str)
                }
            ),
            "real_test_documents": len(real_test),
            **counters,
        },
        "leakage": leakage,
        "near_duplicates": near_duplicates,
        "artifacts": artifacts,
        "training_allowed": not errors and len(train_labels) >= 2,
        "production_ready": False,
        "production_readiness_note": (
            "Structural checks do not certify model quality. Real, reviewed, independent examples "
            "covering every supported category and measured model evaluation are required."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Dataset directory containing manifest.jsonl")
    args = parser.parse_args()
    report = validate_dataset(args.directory)
    if args.directory.is_dir():
        report_path = args.directory / "validation_report.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
