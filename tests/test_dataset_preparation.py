"""End-to-end checks of the generated training artifacts, not model accuracy."""

import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image

from training.check_artifacts import check_artifacts
from training.prepare_dataset import build_dataset, render_ocr_pair
from training.validate_dataset import validate_dataset


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_small_build_is_reproducible_and_uses_real_extraction(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    build_dataset(first, per_template=1, include_images=False)
    build_dataset(second, per_template=1, include_images=False)
    for name in ("manifest.jsonl", "train.jsonl", "validation.jsonl", "test.jsonl"):
        assert (first / name).read_bytes() == (second / name).read_bytes()
    rows = read_rows(first / "manifest.jsonl")
    assert len(rows) == 92  # Eight classes x ten template families, plus twelve unknowns.
    assert len(read_rows(first / "train.jsonl")) == 48
    assert len(read_rows(first / "validation.jsonl")) == 16
    assert len(read_rows(first / "test.jsonl")) == 16
    for row in rows:
        extraction = json.loads((first / row["extraction_path"]).read_text(encoding="utf-8"))
        assert row["text"] == extraction["text"]
        assert row["extractor"] == extraction["extractor"] == "python"
        assert row["extraction_status"] == extraction["status"] == "extracted"
    report = validate_dataset(first)
    assert not report["errors"], report["errors"]
    assert not report["production_ready"]


def test_builder_preserves_existing_data(tmp_path):
    destination = tmp_path / "existing"
    destination.mkdir()
    sentinel = destination / "user-data.txt"
    sentinel.write_text("preserve this", encoding="utf-8")
    with pytest.raises(FileExistsError):
        build_dataset(destination, per_template=1, include_images=False)
    assert sentinel.read_text(encoding="utf-8") == "preserve this"


def test_scan_ground_truth_is_not_mislabeled_as_ocr(tmp_path):
    (tmp_path / "ocr_pending").mkdir()
    parent = {
        "document_id": "doc-scan",
        "text": "Example marksheet\nEnglish: 72 / 100",
        "label": "marksheet",
        "category": "education",
        "group_id": "family-1",
        "split": "test",
        "source_id": "filewise_synthetic_v1",
        "license": "LicenseRef-Filewise-Synthetic",
    }
    rows = render_ocr_pair(parent, tmp_path)
    assert {row["variant"] for row in rows} == {"clear", "degraded"}
    for row in rows:
        assert row["text"] is None
        assert row["expected_text"] == parent["text"]
        assert row["group_id"] == parent["group_id"]
        assert row["split"] == parent["split"]
        assert row["training_eligible"] is False
        assert row["extraction_status"] == "needs_ocr"
        path = tmp_path / row["original_path"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row["original_sha256"]
        with Image.open(path) as image:
            image.verify()


def test_pending_image_cannot_cross_parent_split(tmp_path):
    (tmp_path / "ocr_pending").mkdir()
    parent = {
        "document_id": "doc-scan",
        "text": "Statement of marks\nEnglish 72 / 100",
        "label": "marksheet",
        "category": "education",
        "group_id": "family-1",
        "split": "test",
        "source_id": "filewise_synthetic_v1",
        "license": "LicenseRef-Filewise-Synthetic",
    }
    rows = render_ocr_pair(parent, tmp_path)
    path = tmp_path / "ocr_pending.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    assert not check_artifacts(tmp_path, [parent])["errors"]
    rows[0]["split"] = "train"
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    assert "parent split mismatch" in check_artifacts(tmp_path, [parent])["errors"][0]
