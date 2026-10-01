"""The common output format for every document extractor."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field


class TextPart(BaseModel):
    """One PDF page or DOCX body block; TXT uses a single part."""

    location: str
    text: str
    page_number: int | None = None
    needs_ocr: bool = False


class ExtractionResult(BaseModel):
    schema_version: int = 1
    source_name: str
    file_type: str
    extractor: str = ""
    extractor_version: str = ""
    extracted_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    status: Literal["extracted", "empty", "needs_ocr", "failed"] = "empty"
    text: str = ""
    parts: list[TextPart] = Field(default_factory=list)
    ocr_pages: list[int] = Field(default_factory=list)
    encoding: str | None = None
    error: str | None = None
