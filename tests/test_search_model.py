"""Use the pinned tokenizer and ONNX model when installed (always in search CI)."""

import math
from itertools import pairwise

import pytest

from app.retrieval.chunks import chunks
from app.retrieval.model import MiniLM, model_directory
from app.retrieval.models import Part


@pytest.fixture(scope="module")
def model():
    if not (model_directory() / "onnx/model.onnx").is_file():
        pytest.skip("Download the pinned model to run real-model checks; search CI does this.")
    return MiniLM()


def test_real_token_boundaries_preserve_unicode_and_tail(model):
    text = ("The café reimburses international travel costs. Unaffordable airfare! " * 100)
    parts = chunks([Part(text=text, location="page 9", page_number=9, method="ocr",
                             needs_review=True)], model.tokenizer)
    assert len(parts) > 1
    for part in parts:
        assert part["text"] == text[part["char_start"]:part["char_end"]]
        assert len(model.tokenizer.encode(part["text"]).ids) <= 256
        assert part["page_number"] == 9 and part["needs_review"]
    assert parts[-1]["char_end"] == len(text.rstrip())
    assert all(a["char_end"] > b["char_start"] for a, b in pairwise(parts))


def test_pooling_is_normalized_and_padding_does_not_change_embedding(model):
    short = "travel reimbursement"
    solo = model.encode([short])[0]
    batch = model.encode([short, "Airline tickets and hotel receipts for the business trip."])[0]
    assert len(solo) == 384
    assert math.sqrt(sum(v * v for v in solo)) == pytest.approx(1, abs=1e-5)
    assert batch == pytest.approx(solo, abs=2e-6)
    with pytest.raises(ValueError, match="256-token"):
        model.encode(["travel " * 300])


def test_unknown_token_cannot_create_an_unbounded_passage(model):
    with pytest.raises(ValueError, match="5,000 characters"):
        chunks([Part(text="z" * 20000, location="document", method="extraction")], model.tokenizer)
