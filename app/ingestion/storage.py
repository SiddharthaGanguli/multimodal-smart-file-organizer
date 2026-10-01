from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile


class UploadValidationError(ValueError):
    """Raised when an uploaded file does not satisfy the MVP upload policy."""


@dataclass(frozen=True)
class StoredUpload:
    asset_id: str
    original_filename: str
    extension: str
    detected_media_type: str
    size_bytes: int
    sha256: str
    storage_path: str


SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".jpg", ".jpeg", ".png"}

MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}


def _safe_display_name(filename: str | None) -> str:
    if not filename:
        return "unnamed"
    return Path(filename.replace("\\", "/")).name or "unnamed"


def _looks_like_text(path: Path) -> bool:
    sample = path.read_bytes()[:8192]
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _validate_content_signature(path: Path, extension: str) -> None:
    with path.open("rb") as handle:
        header = handle.read(16)

    if extension == ".pdf" and not header.startswith(b"%PDF-"):
        raise UploadValidationError("The file extension is PDF but its content is not a PDF.")

    if extension in {".jpg", ".jpeg"} and not header.startswith(b"\xff\xd8\xff"):
        raise UploadValidationError("The file extension is JPEG but its content is not a JPEG image.")

    if extension == ".png" and not header.startswith(b"\x89PNG\r\n\x1a\n"):
        raise UploadValidationError("The file extension is PNG but its content is not a PNG image.")

    if extension == ".docx":
        if not zipfile.is_zipfile(path):
            raise UploadValidationError("The file extension is DOCX but the content is not a DOCX package.")
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise UploadValidationError("The uploaded ZIP package is not a valid DOCX document.")

    if extension == ".txt" and not _looks_like_text(path):
        raise UploadValidationError("TXT uploads must contain UTF-8 text without binary data.")


def store_upload(upload: UploadFile, storage_dir: str, max_upload_bytes: int) -> StoredUpload:
    original_filename = _safe_display_name(upload.filename)
    extension = Path(original_filename).suffix.lower()

    if extension not in SUPPORTED_EXTENSIONS:
        allowed = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise UploadValidationError(f"Unsupported file type. Allowed extensions: {allowed}")

    asset_id = str(uuid.uuid4())
    root = Path(storage_dir)
    originals_dir = root / "originals"
    originals_dir.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256()
    total = 0

    fd, temp_name = tempfile.mkstemp(prefix="upload-", dir=originals_dir)
    os.close(fd)
    temp_path = Path(temp_name)

    try:
        with temp_path.open("wb") as destination:
            while True:
                chunk = upload.file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_upload_bytes:
                    raise UploadValidationError(
                        f"File exceeds the {max_upload_bytes // (1024 * 1024)} MB upload limit."
                    )
                digest.update(chunk)
                destination.write(chunk)

        if total == 0:
            raise UploadValidationError("Empty files are not accepted.")

        _validate_content_signature(temp_path, extension)

        final_path = originals_dir / f"{asset_id}{extension}"
        shutil.move(str(temp_path), final_path)

        return StoredUpload(
            asset_id=asset_id,
            original_filename=original_filename,
            extension=extension,
            detected_media_type=MEDIA_TYPES[extension],
            size_bytes=total,
            sha256=digest.hexdigest(),
            storage_path=str(final_path),
        )
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
