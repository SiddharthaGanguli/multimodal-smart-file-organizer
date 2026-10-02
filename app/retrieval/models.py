"""Versioned, bounded API contracts shared by extraction and OCR indexing."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_CHARS = 200_000
MAX_CHUNKS = 256
FILE_ID = r"^[A-Za-z0-9_-]{1,200}$"


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Source(Contract):
    name: str = Field(min_length=1, max_length=1000)
    mime_type: str = Field(min_length=1, max_length=150)
    size: int = Field(gt=0, le=20 * 1024 * 1024)
    modified_time: str = Field(min_length=1, max_length=100)
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class Part(Contract):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    location: str = Field(min_length=1, max_length=150)
    page_number: int | None = Field(default=None, ge=1, le=100_000)
    method: Literal["extraction", "ocr"]
    needs_review: bool = False


class IndexDocument(Contract):
    file_id: str = Field(pattern=FILE_ID)
    source: Source
    parts: list[Part] = Field(min_length=1, max_length=1024)

    @model_validator(mode="after")
    def bounded_text(self):
        if sum(len(part.text) for part in self.parts) > MAX_CHARS:
            raise ValueError("A document can contain at most 200,000 searchable characters.")
        if not any(part.text.strip() for part in self.parts):
            raise ValueError("Extract text or run OCR before indexing this file.")
        return self


class Query(Contract):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=10, ge=1, le=20)


class Forget(Contract):
    file_id: str | None = Field(default=None, pattern=FILE_ID)


class Empty(Contract):
    pass
