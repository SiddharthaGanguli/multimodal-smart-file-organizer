"""Choose an extractor and optionally persist its result as private JSON."""

import logging
import platform
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

from app.core.config import get_settings
from app.extractors.docx import extract_docx
from app.extractors.models import ExtractionResult
from app.extractors.pdf import extract_pdf
from app.extractors.txt import extract_txt

logger = logging.getLogger(__name__)


def extract_document(source: str | Path) -> ExtractionResult:
    """Extract an already-local file. Never change the original or run OCR."""
    path = Path(source)
    file_type = path.suffix.lower().lstrip(".")
    result = ExtractionResult(source_name=path.name, file_type=file_type)
    if file_type not in {"txt", "docx", "pdf"}:
        return result.model_copy(update={"status": "failed", "error": "Unsupported file type."})

    result.extractor = {"txt": "python", "docx": "python-docx", "pdf": "pdfminer.six"}[file_type]
    result.extractor_version = (
        platform.python_version() if file_type == "txt" else version(result.extractor)
    )
    try:
        if file_type == "txt":
            result.parts, result.encoding = extract_txt(path)
        elif file_type == "docx":
            result.parts = extract_docx(path)
        else:
            result.parts = extract_pdf(path)
    except Exception as exc:
        # Third-party parsers raise many error types for malformed documents.
        # Convert failures at this boundary, while retaining diagnostics in local logs.
        logger.debug("Document extraction failed", exc_info=True)
        result.status = "failed"
        result.error = f"Could not read document ({type(exc).__name__})."
        return result

    result.text = "\n\n".join(part.text for part in result.parts if part.text.strip())
    result.ocr_pages = [
        part.page_number for part in result.parts if part.needs_ocr and part.page_number is not None
    ]
    if result.ocr_pages:
        result.status = "needs_ocr"
    else:
        result.status = "extracted" if result.text.strip() else "empty"
    return result


def extract_and_store(
    source: str | Path,
    output_dir: str | Path | None = None,
) -> tuple[ExtractionResult, Path]:
    """Save every outcome, including failures, under a new generated filename."""
    result = extract_document(source)
    directory = (
        Path(output_dir)
        if output_dir is not None
        else Path(get_settings().storage_dir) / "extractions"
    )
    directory.mkdir(parents=True, exist_ok=True)
    result_path = directory / f"{uuid4().hex}.json"
    # Exclusive creation also prevents accidentally overwriting an existing original.
    with result_path.open("x", encoding="utf-8") as stream:
        stream.write(result.model_dump_json(indent=2))
    return result, result_path
