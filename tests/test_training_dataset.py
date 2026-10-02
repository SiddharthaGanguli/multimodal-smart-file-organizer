"""Checks that dataset validation rejects leakage and tampered preparation output."""

import hashlib
import json
from pathlib import Path

import pytest

from training.validate_dataset import validate_dataset


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _record(directory: Path, identifier: str, split: str, label: str = "invoice") -> dict:
    text = f"Distinct fictional content for {identifier}; label reviewed by test fixture."
    original = directory / "originals" / f"{identifier}.txt"
    original.parent.mkdir(exist_ok=True)
    original.write_bytes(text.encode("utf-8"))
    return {
        "document_id": identifier,
        "label": label,
        "category": "education" if label == "marksheet" else "bills_payments",
        "text": text,
        "text_sha256": _digest(text),
        "original_sha256": _digest(text),
        "original_path": original.relative_to(directory).as_posix(),
        "group_id": f"family_{identifier}",
        "template_id": f"template_{identifier}",
        "source_id": "fictional_test_fixtures",
        "source_url": "https://example.org/fixtures",
        "license": "CC0-1.0",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "is_synthetic": True,
        "language": "en",
        "review_status": "synthetic_label_from_generator",
        "split": split,
        "extraction_status": "extracted",
        "extractor": "test_fixture",
        "extractor_version": "1.0",
        "text_origin": "filewise_extractor",
    }


def _write(directory: Path, records: list[dict]) -> None:
    def write_jsonl(filename: str, items: list[dict]) -> None:
        content = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in items)
        (directory / filename).write_text(content, encoding="utf-8")

    write_jsonl("manifest.jsonl", records)
    for split in ("train", "validation", "test", "challenge"):
        write_jsonl(f"{split}.jsonl", [record for record in records if record["split"] == split])


def _small_dataset(directory: Path) -> list[dict]:
    records = [
        _record(directory, "train_invoice", "train"),
        _record(directory, "train_marksheet", "train", "marksheet"),
        _record(directory, "validation_invoice", "validation"),
        _record(directory, "test_invoice", "test"),
    ]
    _write(directory, records)
    return records


def test_valid_pilot_does_not_claim_production_readiness(tmp_path):
    _small_dataset(tmp_path)

    report = validate_dataset(tmp_path)

    assert report["errors"] == []
    assert report["status"] == "passed"
    assert report["training_allowed"] is True
    assert report["production_ready"] is False
    assert report["counts"]["synthetic"] == 4
    assert any("No real-document test set" in warning for warning in report["warnings"])


@pytest.mark.parametrize("field", ["group_id", "template_id"])
def test_related_families_cannot_cross_splits(tmp_path, field):
    records = _small_dataset(tmp_path)
    records[-1][field] = records[0][field]
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert report["training_allowed"] is False
    assert report["leakage"][f"{field}_cross_split_groups"] == 1


def test_duplicate_content_cannot_evade_split_check_with_new_ids(tmp_path):
    records = _small_dataset(tmp_path)
    duplicate = records[-1]
    duplicate["text"] = records[0]["text"]
    duplicate["text_sha256"] = records[0]["text_sha256"]
    duplicate["original_sha256"] = records[0]["original_sha256"]
    (tmp_path / duplicate["original_path"]).write_bytes(duplicate["text"].encode("utf-8"))
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert report["leakage"]["text_sha256_cross_split_groups"] == 1
    assert report["leakage"]["original_sha256_cross_split_groups"] == 1
    assert report["status"] == "failed"


def test_tampered_export_and_missing_export_are_rejected(tmp_path):
    _small_dataset(tmp_path)
    exported = json.loads((tmp_path / "test.jsonl").read_text(encoding="utf-8"))
    exported["label"] = "marksheet"
    (tmp_path / "test.jsonl").write_text(json.dumps(exported) + "\n", encoding="utf-8")
    (tmp_path / "validation.jsonl").write_text("", encoding="utf-8")

    report = validate_dataset(tmp_path)

    assert any("differs from manifest" in error for error in report["errors"])
    assert any("expected exactly one split export, found 0" in error for error in report["errors"])


def test_tampered_original_is_rejected(tmp_path):
    records = _small_dataset(tmp_path)
    (tmp_path / records[0]["original_path"]).write_text("Changed content", encoding="utf-8")

    report = validate_dataset(tmp_path)

    assert any("original_sha256 does not match" in error for error in report["errors"])


def test_extraction_record_must_match_saved_result(tmp_path):
    records = _small_dataset(tmp_path)
    records[0]["extraction_path"] = "extraction.json"
    (tmp_path / "extraction.json").write_text(json.dumps({
        "text": "An unrelated extraction", "extractor": "test_fixture",
        "extractor_version": "1.0", "status": "extracted",
    }), encoding="utf-8")
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert any("text differs from stored extraction result" in error for error in report["errors"])


def test_snapshot_checksum_and_incomplete_build_are_rejected(tmp_path):
    _small_dataset(tmp_path)
    (tmp_path / "BUILD_IN_PROGRESS.json").write_text("{}", encoding="utf-8")
    (tmp_path / "checksums.json").write_text(
        json.dumps({"manifest.jsonl": "0" * 64}), encoding="utf-8"
    )

    report = validate_dataset(tmp_path)

    assert any("build is incomplete" in error for error in report["errors"])
    assert any("checksum mismatch" in error for error in report["errors"])


def test_dataset_uses_its_frozen_category_definitions(tmp_path):
    records = _small_dataset(tmp_path)
    records[1]["category"] = "frozen_education"
    _write(tmp_path, records)
    (tmp_path / "categories.json").write_text(json.dumps({"categories": [
        {"label": "marksheet", "category": "frozen_education"},
        {"label": "invoice", "category": "bills_payments"},
    ]}), encoding="utf-8")

    assert validate_dataset(tmp_path)["errors"] == []


@pytest.mark.parametrize("path", ["../outside.txt", "originals/../../outside.txt", "C:\\secret.txt"])
def test_original_paths_cannot_escape_dataset(tmp_path, path):
    records = _small_dataset(tmp_path)
    records[0]["original_path"] = path
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert any("must stay inside the dataset" in error for error in report["errors"])


def test_malformed_records_return_errors_instead_of_crashing(tmp_path):
    records = _small_dataset(tmp_path)
    records[0].update({"extraction_status": [], "text_origin": {}, "text": 42, "label": []})
    _write(tmp_path, records)
    with (tmp_path / "manifest.jsonl").open("a", encoding="utf-8") as output:
        output.write("not json\n[]\n")

    report = validate_dataset(tmp_path)

    assert report["status"] == "failed"
    assert any("invalid JSON" in error for error in report["errors"])
    assert any("record must be an object" in error for error in report["errors"])
    assert any("text must be a string" in error for error in report["errors"])


def test_unreadable_documents_are_excluded_from_model_splits(tmp_path):
    records = _small_dataset(tmp_path)
    records[0]["extraction_status"] = "needs_ocr"
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert any("model split requires extraction_status=extracted" in error
               for error in report["errors"])


def test_challenge_is_unlabeled_and_can_have_empty_text(tmp_path):
    records = _small_dataset(tmp_path)
    challenge = _record(tmp_path, "unreadable", "challenge")
    challenge.update({"label": None, "category": None, "text": "", "text_sha256": _digest(""),
                      "extraction_status": "empty"})
    records.append(challenge)
    _write(tmp_path, records)

    assert validate_dataset(tmp_path)["errors"] == []

    challenge["label"] = "other"
    _write(tmp_path, records)
    assert any("challenge label and category must be null" in error
               for error in validate_dataset(tmp_path)["errors"])


def test_near_duplicate_candidates_are_reported_without_claiming_semantic_audit(tmp_path):
    records = _small_dataset(tmp_path)
    for index in (0, -1):
        words = [f"token{number}" for number in range(100)]
        if index == -1:
            words[-1] = "changed"
        records[index]["text"] = " ".join(words)
        records[index]["text_sha256"] = _digest(records[index]["text"])
    _write(tmp_path, records)

    report = validate_dataset(tmp_path)

    assert report["near_duplicates"]["cross_split_candidate_pairs"] == 1
    assert "semantic duplicates" in report["near_duplicates"]["limitation"]
    assert any("Near-duplicate candidates" in warning for warning in report["warnings"])
