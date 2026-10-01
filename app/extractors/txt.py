"""Read UTF-8 text, or UTF-16 text with a byte-order mark."""

from pathlib import Path

from app.extractors.models import TextPart


def extract_txt(path: Path) -> tuple[list[TextPart], str]:
    data = path.read_bytes()
    encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    text = data.decode(encoding).replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in text:
        raise ValueError("TXT contains null bytes; save it as UTF-8 or BOM-marked UTF-16.")
    return [TextPart(location="document", text=text)], encoding
