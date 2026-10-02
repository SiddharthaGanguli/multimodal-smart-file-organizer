"""Search authorization, versioning and request-boundary regressions."""

import copy
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.extraction import FILEWISE_ORIGIN
from app.retrieval.chunks import chunks
from app.retrieval.drive import DriveSession, SearchError
from app.retrieval.models import IndexDocument, Part, Query, Source
from app.retrieval.service import SearchService
from app.search_api import RateLimit, create_app

SOURCE = Source(name="invoice.pdf", mime_type="application/pdf", size=100,
                modified_time="2026-10-02T00:00:00Z")
DOCUMENT = IndexDocument(file_id="file-1", source=SOURCE,
                         parts=[Part(text="Air travel invoice paid in full", location="page 2",
                                     page_number=2, method="ocr", needs_review=True)])


class Tokenizer:
    def encode(self, text, add_special_tokens=True):
        offsets = [(i, i + 1) for i in range(len(text))]
        return SimpleNamespace(ids=list(range(len(text) + (2 if add_special_tokens else 0))),
                               offsets=offsets)


class Model:
    key = "test-model"
    tokenizer = Tokenizer()

    def encode(self, texts):
        return [[1.0] + [0.0] * 383 for _ in texts]


class Store:
    def __init__(self):
        self.rows = {}
        self.hits = []
        self.deleted = []

    def get(self, owner, file_id, model):
        return self.rows.get((owner, file_id, model))

    def replace(self, owner, document, model, digest, passages, vectors):
        self.rows[owner, document.file_id, model] = {"content_hash": digest, "passages": passages}

    def search(self, owner, model, vector, limit):
        return [h for h in self.hits if h["owner"] == owner and h["model"] == model][:limit]

    def delete(self, owner, file_id=None, digest=None):
        self.deleted.append((owner, file_id, digest))
        return 1

    def status(self, owner, model):
        return []


class Session:
    def __init__(self, token="A"):
        self.owner = token
        self.current = SOURCE
        self.closed = False

    def authenticate(self):
        if self.owner == "invalid":
            raise SearchError(401, "Reconnect")
        return self.owner

    def source(self, file_id):
        if isinstance(self.current, Exception):
            raise self.current
        return self.current

    def close(self):
        self.closed = True


def hit(owner="A", model="test-model", **kwargs):
    return {"owner": owner, "model": model, "file_id": "file-1", "source": SOURCE.model_dump(),
            "content_hash": "old", "needs_review": True, "distance": 0.2,
            "passage": {"text": "paid in full", "location": "page 2", "page_number": 2,
                        "method": "ocr", "needs_review": True}, **kwargs}


def test_chunks_preserve_unicode_offsets_overlap_and_page_references():
    text = "Paid invoice 😀 " * 70
    parts = [Part(text=text, location="page 7", page_number=7, method="ocr")]
    result = chunks(parts, Tokenizer())
    assert len(result) > 1
    assert all(p["text"] == text[p["char_start"]:p["char_end"]] for p in result)
    assert all(p["page_number"] == 7 for p in result)
    assert result[1]["char_start"] == result[0]["char_end"] - 32
    assert result[-1]["char_end"] == len(text)


def test_index_is_idempotent_and_keeps_review_provenance():
    store = Store()
    service = SearchService(store, Model())
    assert service.index(Session(), DOCUMENT)["status"] == "indexed"
    assert service.index(Session(), DOCUMENT)["status"] == "unchanged"
    assert store.rows["A", "file-1", "test-model"]["passages"][0]["needs_review"]


def test_remote_change_during_embedding_never_commits():
    session = Session()
    model = Model()
    model.encode = lambda texts: (setattr(session, "current", SOURCE.model_copy(update={"size": 101}))
                                 or [[1.0] * 384])
    store = Store()
    with pytest.raises(SearchError, match="changed during"):
        SearchService(store, model).index(session, DOCUMENT)
    assert not store.rows


@pytest.mark.parametrize("current", [SearchError(403, "Revoked"), SearchError(404, "Deleted"),
                                     SOURCE.model_copy(update={"modified_time": "changed"})])
def test_search_removes_inaccessible_or_stale_passages(current):
    store = Store()
    store.hits = [hit()]
    session = Session()
    session.current = current
    assert SearchService(store, Model()).query(session, Query(query="travel"))["results"] == []
    assert store.deleted == [("A", "file-1", "old")]


def test_transient_drive_failure_never_returns_cached_text_or_deletes_index():
    store = Store()
    store.hits = [hit()]
    session = Session()
    session.current = SearchError(503, "Offline")
    with pytest.raises(SearchError):
        SearchService(store, Model()).query(session, Query(query="travel"))
    assert not store.deleted


def test_owner_and_model_filter_and_reference_are_preserved():
    store = Store()
    store.hits = [hit(owner="B"), hit(model="different"), hit()]
    results = SearchService(store, Model()).query(Session(), Query(query="travel"))["results"]
    assert len(results) == 1
    assert results[0]["page_number"] == 2 and results[0]["needs_review"]


def test_low_similarity_and_empty_queries_have_no_misleading_match():
    store = Store()
    store.hits = [hit(distance=0.9)]
    service = SearchService(store, Model())
    assert service.query(Session(), Query(query="unrelated"))["results"] == []
    with pytest.raises(SearchError):
        service.query(Session(), Query(query="   "))


HEADERS = {"Origin": FILEWISE_ORIGIN, "X-Filewise-Request": "search-v1",
           "Authorization": "Bearer A"}


def test_api_never_trusts_submitted_owner_and_clears_token_session():
    session = Session()
    service = SearchService(Store(), Model())
    with TestClient(create_app(service, lambda token: session), base_url="https://testserver") as client:
        body = DOCUMENT.model_dump()
        body["owner_id"] = "B"
        response = client.post("/v1/search/index", headers=HEADERS, json=body)
        assert response.status_code == 422
        assert "Air travel" not in response.text
        response = client.post("/v1/search/index", headers=HEADERS, json=DOCUMENT.model_dump())
        assert response.status_code == 200 and session.closed
        assert ("A", "file-1", "test-model") in service.store.rows
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("change,status", [({"Origin": "https://evil.test"}, 403),
                                          ({"Authorization": ""}, 401),
                                          ({"Authorization": "Bearer invalid"}, 401),
                                          ({"X-Filewise-Request": ""}, 403)])
def test_api_rejects_wrong_origin_and_missing_or_invalid_auth(change, status):
    with TestClient(create_app(SearchService(Store(), Model()), Session),
                    base_url="https://testserver") as client:
        response = client.post("/v1/search/query", headers=HEADERS | change, json={"query": "travel"})
        assert response.status_code == status


def test_api_limits_body_and_redacts_unexpected_backend_errors():
    service = SearchService(Store(), Model())
    service.query = lambda *args: (_ for _ in ()).throw(RuntimeError("secret database credentials"))
    with TestClient(create_app(service, Session), base_url="https://testserver") as client:
        response = client.post("/v1/search/query", headers=HEADERS, json={"query": "x" * 1_000_001})
        assert response.status_code == 413
        response = client.post("/v1/search/query", headers=HEADERS, json={"query": "travel"})
        assert response.status_code == 503 and "secret" not in response.text


def test_rate_limits_are_per_verified_owner():
    limiter = RateLimit()
    for _ in range(10):
        limiter.check("A", "index")
    with pytest.raises(SearchError) as caught:
        limiter.check("A", "index")
    assert caught.value.status == 429
    limiter.check("B", "index")


def test_drive_uses_google_identity_and_does_not_follow_redirects():
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith("about"):
            return httpx.Response(200, json={"user": {"permissionId": "verified-A"}})
        return httpx.Response(302, headers={"Location": "https://evil.test"})

    with httpx.Client(transport=httpx.MockTransport(respond), follow_redirects=False) as client:
        session = DriveSession("test-token", client)
        assert session.authenticate() == "verified-A"
        with pytest.raises(SearchError):
            session.source("file-1")
        assert len(requests) == 2
        assert all(r.url.host == "www.googleapis.com" for r in requests)
        session.close()
        assert session.token is None


def test_oversize_empty_text_and_unknown_fields_are_rejected():
    for changes in [{"parts": []}, {"parts": [{"text": " " * 20, "location": "doc", "method": "extraction"}]},
                    {"file_id": "../../secret"}, {"owner_id": "B"}]:
        with pytest.raises(ValueError):
            IndexDocument.model_validate(copy.deepcopy(DOCUMENT.model_dump()) | changes)
