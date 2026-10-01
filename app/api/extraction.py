"""Temporary local uploads connecting Filewise to the document extractors."""

import re
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

import anyio
from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from app.extractors import extract_document
from app.extractors.models import ExtractionResult

FILEWISE_ORIGIN = "chrome-extension://llobmhbiebleflpmbfdobhbkecbgefab"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_DOCX_ENTRIES = 2000
SUPPORTED_SUFFIXES = {".txt", ".docx", ".pdf"}

router = APIRouter(tags=["extraction"])


def _validate_filename(filename: str) -> str:
    """Accept a display basename, never a local path or a URL."""
    if (
        filename in {".", ".."}
        or filename.endswith((" ", "."))
        or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename)
    ):
        raise HTTPException(400, "filename must be a file basename, not a path or URL.")
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(415, "Supported document types are TXT, DOCX, and PDF.")
    return suffix


def _extract_upload(source: Path, filename: str) -> ExtractionResult:
    """Run parsing and compressed-DOCX limits away from the event loop."""
    if source.suffix == ".docx":
        try:
            with ZipFile(source) as archive:
                entries = archive.infolist()
                if (
                    len(entries) > MAX_DOCX_ENTRIES
                    or sum(entry.file_size for entry in entries) > MAX_DOCX_EXPANDED_BYTES
                ):
                    raise HTTPException(413, "The expanded DOCX document is too large.")
        except BadZipFile:
            # The shared extractor returns a consistent failed result for corrupt input.
            pass
    result = extract_document(source)
    result.source_name = filename
    return result


@router.post("/extractions", response_model=ExtractionResult)
async def extract_upload(
    request: Request,
    filename: str = Query(min_length=1, max_length=255),
) -> ExtractionResult:
    """Extract uploaded bytes without retaining the document or extraction result."""
    if request.headers.get("origin") != FILEWISE_ORIGIN:
        raise HTTPException(403, "Only the configured Filewise extension can request extraction.")
    if request.headers.get("x-filewise-request") != "extraction-v1":
        raise HTTPException(403, "The Filewise extraction request header is required.")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/octet-stream":
        raise HTTPException(415, "Send document bytes as application/octet-stream.")
    suffix = _validate_filename(filename)
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length header.") from None
        if length < 0:
            raise HTTPException(400, "Invalid Content-Length header.")
        if length > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Document exceeds the 20 MiB extraction limit.")

    # The supplied filename is metadata only; it is never used to construct a path.
    with TemporaryDirectory(prefix="filewise-extraction-") as directory:
        source = Path(directory) / f"upload{suffix}"
        received = 0
        async with await anyio.open_file(source, "xb") as stream:
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Document exceeds the 20 MiB extraction limit.")
                await stream.write(chunk)
        return await run_in_threadpool(_extract_upload, source, filename)
