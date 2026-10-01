"""Read DOCX body paragraphs and tables in document order."""

from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from app.extractors.models import TextPart


def _table_text(table: Table) -> str:
    rows = []
    seen_cells = set()
    for row in table.rows:
        cells = []
        for cell in row.cells:
            # Merged positions share the same XML cell; keep its text only once.
            if cell._tc in seen_cells:
                cells.append("")
                continue
            seen_cells.add(cell._tc)
            blocks = [
                block.text if isinstance(block, Paragraph) else _table_text(block)
                for block in cell.iter_inner_content()
            ]
            cells.append("\n".join(blocks).strip())
        rows.append("\t".join(cells))
    return "\n".join(rows)


def extract_docx(path: Path) -> list[TextPart]:
    document = Document(path)
    # Unwrap Word content controls in memory, including nested/inline controls.
    # python-docx otherwise silently skips their contents. The file is never saved.
    for control in reversed(document.element.body.xpath(".//w:sdt")):
        parent = control.getparent()
        content = control.find(qn("w:sdtContent"))
        position = parent.index(control)
        if content is not None:
            for child in list(content):
                parent.insert(position, child)
                position += 1
        parent.remove(control)
    parts = []
    for index, block in enumerate(document.iter_inner_content(), start=1):
        kind = "paragraph" if isinstance(block, Paragraph) else "table"
        text = block.text if isinstance(block, Paragraph) else _table_text(block)
        parts.append(TextPart(location=f"body/{kind}/{index}", text=text))
    return parts
