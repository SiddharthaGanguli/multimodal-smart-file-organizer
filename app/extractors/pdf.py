"""Read PDF text page by page and flag likely OCR candidates."""

from pathlib import Path

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTContainer, LTImage, LTTextContainer

from app.extractors.models import TextPart

# A large image with only a caption/page number may be a scanned document.
MIN_TEXT_CHARACTERS = 50
LARGE_IMAGE_PAGE_FRACTION = 0.5


def _text_blocks(container: LTContainer):
    for element in container:
        if isinstance(element, LTTextContainer):
            yield element.get_text()
        elif isinstance(element, LTContainer):
            yield from _text_blocks(element)


def _image_areas(container: LTContainer):
    for element in container:
        if isinstance(element, LTImage):
            yield max(0, element.width) * max(0, element.height)
        elif isinstance(element, LTContainer):
            yield from _image_areas(element)


def extract_pdf(path: Path) -> list[TextPart]:
    parts = []
    for number, page in enumerate(extract_pages(path, laparams=LAParams(all_texts=True)), 1):
        text = "\n".join(_text_blocks(page)).strip()
        text_characters = sum(character.isalnum() for character in text)
        page_area = page.width * page.height
        largest_image = max(_image_areas(page), default=0)
        large_image = page_area > 0 and largest_image / page_area >= LARGE_IMAGE_PAGE_FRACTION
        needs_ocr = text_characters == 0 or (large_image and text_characters < MIN_TEXT_CHARACTERS)
        parts.append(
            TextPart(
                location=f"page/{number}",
                page_number=number,
                text=text,
                needs_ocr=needs_ocr,
            )
        )
    return parts
