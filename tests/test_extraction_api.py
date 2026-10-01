"""Exercise the localhost bridge with real documents and rejected requests."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from docx import Document
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas

from app.api import extraction
from app.main import app

HEADERS = {
    "Origin": extraction.FILEWISE_ORIGIN,
    "X-Filewise-Request": "extraction-v1",
    "Content-Type": "application/octet-stream",
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Every test can inspect the directory to prove no originals were retained.
    monkeypatch.setattr(
        extraction,
        "TemporaryDirectory",
        lambda **kwargs: TemporaryDirectory(dir=tmp_path, **kwargs),
    )
    with TestClient(app) as test_client:
        yield test_client
    assert list(tmp_path.iterdir()) == []


def upload(client, filename, content, headers=None):
    return client.post(
        "/extractions",
        params={"filename": filename},
        content=content,
        headers=HEADERS if headers is None else headers,
    )


def test_extract_txt_returns_original_name_and_schema(client):
    response = upload(client, "Invoice.TXT", "Invoice ₹250\r\nPaid".encode())
    assert response.status_code == 200
    result = response.json()
    assert result["schema_version"] == 1
    assert result["source_name"] == "Invoice.TXT"
    assert result["status"] == "extracted"
    assert result["text"] == "Invoice ₹250\nPaid"
    assert result["parts"][0]["text"] == result["text"]
    assert response.headers["access-control-allow-origin"] == extraction.FILEWISE_ORIGIN


def test_extract_real_pdf_pages(client):
    output = BytesIO()
    document = canvas.Canvas(output)
    for text in ["Invoice total 250", "Thank you"]:
        document.drawString(72, 720, text)
        document.showPage()
    document.save()
    response = upload(client, "report.pdf", output.getvalue())
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "extracted"
    assert "Invoice total 250" in result["text"]
    assert "Thank you" in result["text"]
    assert [part["page_number"] for part in result["parts"]] == [1, 2]
    assert result["ocr_pages"] == []


def test_extract_real_docx(client):
    output = BytesIO()
    document = Document()
    document.add_paragraph("Team report")
    document.save(output)
    result = upload(client, "report.docx", output.getvalue()).json()
    assert result["status"] == "extracted"
    assert result["text"] == "Team report"


@pytest.mark.parametrize("filename", ["broken.pdf", "broken.docx"])
def test_corrupt_document_returns_failed_schema_and_cleans_upload(client, filename):
    response = upload(client, filename, b"not a valid document")
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["source_name"] == filename
    assert response.json()["error"].startswith("Could not read document")


def test_empty_document_is_an_extraction_outcome(client):
    response = upload(client, "empty.txt", b"")
    assert response.status_code == 200
    assert response.json()["status"] == "empty"


@pytest.mark.parametrize(
    "changes",
    [
        {"Origin": None},
        {"Origin": "https://example.com"},
        {"Origin": "chrome-extension://different-extension"},
        {"X-Filewise-Request": None},
        {"X-Filewise-Request": "incorrect"},
    ],
)
def test_origin_and_request_header_are_required(client, changes):
    headers = dict(HEADERS)
    for key, value in changes.items():
        if value is None:
            headers.pop(key)
        else:
            headers[key] = value
    response = upload(client, "notes.txt", b"secret", headers)
    assert response.status_code == 403


def test_cors_preflight_only_allows_shared_extension(client):
    preflight = {
        "Origin": extraction.FILEWISE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-filewise-request",
    }
    response = client.options("/extractions", headers=preflight)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == extraction.FILEWISE_ORIGIN
    preflight["Origin"] = "https://example.com"
    denied = client.options("/extractions", headers=preflight)
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.parametrize(
    "filename",
    ["../notes.txt", r"..\notes.txt", "C:notes.txt", "https://example.com/a.pdf", "a\x00.txt"],
)
def test_paths_and_urls_are_rejected(client, filename):
    assert upload(client, filename, b"sample").status_code == 400


def test_unsupported_type_and_wrong_content_type(client):
    assert upload(client, "photo.jpg", b"sample").status_code == 415
    headers = {**HEADERS, "Content-Type": "text/plain"}
    assert upload(client, "notes.txt", b"sample", headers).status_code == 415


def test_upload_limit_checks_declared_and_streamed_size(client, monkeypatch):
    monkeypatch.setattr(extraction, "MAX_UPLOAD_BYTES", 8)
    assert upload(client, "notes.txt", b"123456789").status_code == 413
    # A missing or misleading Content-Length cannot bypass the running byte count.
    headers = {**HEADERS, "Content-Length": "1"}
    assert upload(client, "notes.txt", b"123456789", headers).status_code == 413
    assert upload(client, "notes.txt", b"12345678").status_code == 200


def test_docx_expanded_size_limit(client, monkeypatch):
    monkeypatch.setattr(extraction, "MAX_DOCX_EXPANDED_BYTES", 1024)
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"a" * 2048)
    response = upload(client, "large.docx", output.getvalue())
    assert response.status_code == 413
    assert "expanded DOCX" in response.json()["detail"]


def test_unexpected_failure_still_removes_temporary_original(client, monkeypatch, tmp_path):
    observed_paths = []

    def fail(source: Path):
        observed_paths.append(source)
        assert source.read_bytes() == b"sample"
        raise RuntimeError("unexpected parser failure")

    monkeypatch.setattr(extraction, "extract_document", fail)
    with pytest.raises(RuntimeError, match="unexpected parser failure"):
        upload(client, "notes.txt", b"sample")
    assert observed_paths
    assert all(not source.exists() for source in observed_paths)
    assert list(tmp_path.iterdir()) == []
