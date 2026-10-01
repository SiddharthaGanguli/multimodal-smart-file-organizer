"""Run with: python -m app.extractors path/to/document.pdf"""

import argparse
from pathlib import Path

from app.extractors.service import extract_and_store


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract TXT, DOCX, or PDF text to JSON.")
    parser.add_argument("source", type=Path, help="Path to a local document")
    parser.add_argument("--output-dir", type=Path, help="Defaults to STORAGE_DIR/extractions")
    args = parser.parse_args()
    try:
        result, destination = extract_and_store(args.source, args.output_dir)
    except OSError as exc:
        parser.exit(1, f"Could not save extraction result: {exc}\n")
    print(f"Status: {result.status}")
    print(f"Result: {destination.resolve()}")
    if result.ocr_pages:
        print(f"Pages needing OCR: {result.ocr_pages}")
    if result.error:
        print(result.error)
    return 1 if result.status == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
