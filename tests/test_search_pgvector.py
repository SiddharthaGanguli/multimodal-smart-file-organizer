"""Real PostgreSQL tests. CI provides a dedicated non-superuser database role."""

import os
import uuid

import pytest

pytest.importorskip("psycopg")

from app.retrieval.models import IndexDocument, Part, Source
from app.retrieval.store import VectorStore


@pytest.fixture
def database():
    url = os.environ.get("SEARCH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set SEARCH_TEST_DATABASE_URL for real pgvector integration; CI supplies it.")
    store = VectorStore(url)
    store.ready()
    a, b = "test-" + uuid.uuid4().hex, "test-" + uuid.uuid4().hex
    yield store, a, b
    store.delete(a)
    store.delete(b)


def sample(file_id, text):
    return IndexDocument(file_id=file_id, source=Source(name=file_id + ".txt", mime_type="text/plain",
                                                       size=100, modified_time="2026-10-02T00:00:00Z"),
                         parts=[Part(text=text, location="document", method="extraction")])


def test_pgvector_owner_model_rank_collapse_and_replace(database):
    store, a, b = database
    v = [1.0] + [0.0] * 383
    other = [0.0, 1.0] + [0.0] * 382
    passage = {"text": "travel payment", "page_number": 2, "location": "page 2",
               "method": "ocr", "needs_review": True}
    store.replace(a, sample("same", "A"), "v1", "hash-a", [passage, passage], [v, v])
    store.replace(b, sample("same", "B"), "v1", "hash-b", [passage], [v])
    store.replace(a, sample("second", "A2"), "v1", "hash-2", [passage], [other])
    hits = store.search(a, "v1", v, 10)
    assert [hit["file_id"] for hit in hits] == ["same", "second"]
    assert hits[0]["distance"] == pytest.approx(0)
    assert hits[0]["content_hash"] == "hash-a"
    assert store.search(a, "v2", v, 10) == []
    # RLS also protects queries that accidentally omit the explicit owner predicate.
    with store.connection(a) as conn:
        assert conn.execute("SELECT count(*) AS n FROM filewise_search_documents "
                            "WHERE owner_id=%s", (b,)).fetchone()["n"] == 0
    store.replace(a, sample("same", "new"), "v2", "hash-new", [passage], [v])
    assert store.get(a, "same", "v1") is None
    assert store.get(b, "same", "v1")["content_hash"] == "hash-b"
    assert store.delete(a, "same", "hash-a") == 0  # A stale search cannot delete a newer index.
    assert store.delete(a, "same", "hash-new") == 1


def test_pgvector_replace_rolls_back_if_vector_is_invalid(database):
    store, a, _ = database
    v = [1.0] + [0.0] * 383
    passage = {"text": "original", "needs_review": False}
    store.replace(a, sample("file", "original"), "v1", "original", [passage], [v])
    with pytest.raises(ValueError):
        store.replace(a, sample("file", "replacement"), "v1", "bad", [passage], [[float("nan")] * 384])
    assert store.get(a, "file", "v1")["content_hash"] == "original"
