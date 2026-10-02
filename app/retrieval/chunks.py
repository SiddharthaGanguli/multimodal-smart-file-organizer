"""Tokenizer-aware windows preserve original text and page/block provenance."""

from app.retrieval.models import MAX_CHUNKS


def chunks(parts, tokenizer, size=224, overlap=32):
    if not 0 <= overlap < size <= 224:
        raise ValueError("Invalid token window")
    result = []
    for part in parts:
        offsets = tokenizer.encode(part.text, add_special_tokens=False).offsets
        for start in range(0, len(offsets), size - overlap):
            selected = offsets[start:start + size]
            first, last = selected[0][0], selected[-1][1]
            text = part.text[first:last]
            if not text.strip():
                continue
            # Unknown tokens can represent arbitrarily long words. Bound stored
            # passages too, rather than relying on the tokenizer to cap characters.
            if len(text) > 5000:
                raise ValueError("A passage exceeds 5,000 characters; split long unbroken text.")
            # Retokenizing an original span can split a partial word differently.
            # Shrink until the final encoded input is guaranteed not to truncate.
            while len(tokenizer.encode(text).ids) > 256 and last > first:
                last -= 1
                text = part.text[first:last]
            result.append({"text": text, "location": part.location,
                           "page_number": part.page_number, "method": part.method,
                           "needs_review": part.needs_review, "char_start": first,
                           "char_end": last, "token_start": start})
            if len(result) > MAX_CHUNKS:
                raise ValueError("Document exceeds 256 searchable chunks; split it into smaller files.")
            if start + size >= len(offsets):
                break
    if not result:
        raise ValueError("No searchable text was found.")
    return result
