from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app


def _configure_test_storage(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "storage"))
    monkeypatch.setenv("ASSET_DATABASE_PATH", str(tmp_path / "assets.sqlite3"))
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1048576")
    get_settings.cache_clear()


def test_upload_txt_preserves_content_and_metadata(tmp_path: Path, monkeypatch) -> None:
    _configure_test_storage(tmp_path, monkeypatch)
    client = TestClient(app)
    content = b"hello smart file organizer"

    response = client.post(
        "/api/v1/assets",
        files={"file": ("notes.txt", content, "text/plain")},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["original_filename"] == "notes.txt"
    assert body["extension"] == ".txt"
    assert body["detected_media_type"] == "text/plain"
    assert body["size_bytes"] == len(content)
    assert body["sha256"] == hashlib.sha256(content).hexdigest()
    assert "storage_path" not in body

    content_response = client.get(f"/api/v1/assets/{body['asset_id']}/content")
    assert content_response.status_code == 200
    assert content_response.content == content


def test_rejects_unsupported_extension(tmp_path: Path, monkeypatch) -> None:
    _configure_test_storage(tmp_path, monkeypatch)
    client = TestClient(app)

    response = client.post(
        "/api/v1/assets",
        files={"file": ("archive.exe", b"not-an-executable", "application/octet-stream")},
    )

    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


def test_rejects_fake_pdf(tmp_path: Path, monkeypatch) -> None:
    _configure_test_storage(tmp_path, monkeypatch)
    client = TestClient(app)

    response = client.post(
        "/api/v1/assets",
        files={"file": ("fake.pdf", b"this is not a pdf", "application/pdf")},
    )

    assert response.status_code == 400
    assert "not a PDF" in response.json()["detail"]


def test_rejects_empty_file(tmp_path: Path, monkeypatch) -> None:
    _configure_test_storage(tmp_path, monkeypatch)
    client = TestClient(app)

    response = client.post(
        "/api/v1/assets",
        files={"file": ("empty.txt", b"", "text/plain")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Empty files are not accepted."
