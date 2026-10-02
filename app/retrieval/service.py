"""Index and retrieve only current, authorized text from the authenticated account."""

import hashlib
import json
import time
from threading import BoundedSemaphore

from app.retrieval.chunks import chunks
from app.retrieval.drive import SearchError, matches
from app.retrieval.models import Source


class SearchService:
    def __init__(self, store, model, minimum_score=0.35):
        self.store = store
        self.model = model
        self.minimum_score = minimum_score
        self.index_slot = BoundedSemaphore(1)

    def index(self, session, document):
        if not self.index_slot.acquire(blocking=False):
            raise SearchError(503, "Search is indexing another file. Retry shortly.")
        try:
            source = session.source(document.file_id)
            if not matches(document.source, source):
                raise SearchError(409, "The file changed. Extract its current text and retry indexing.")
            document = document.model_copy(update={"source": source})
            digest = hashlib.sha256(json.dumps(document.model_dump(), sort_keys=True,
                                               ensure_ascii=False).encode()).hexdigest()
            current = self.store.get(session.owner, document.file_id, self.model.key)
            if current and current["content_hash"] == digest:
                return {"file_id": document.file_id, "status": "unchanged", "model_key": self.model.key}
            passages = chunks(document.parts, self.model.tokenizer)
            vectors = self.model.encode([part["text"] for part in passages])
            latest = session.source(document.file_id)
            if not matches(source, latest):
                raise SearchError(409, "The file changed during indexing. Refresh and retry.")
            self.store.replace(session.owner, document, self.model.key, digest, passages, vectors)
            return {"file_id": document.file_id, "status": "indexed", "chunks": len(passages),
                    "model_key": self.model.key}
        finally:
            self.index_slot.release()

    def query(self, session, query):
        text = query.query.strip()
        if not text:
            raise SearchError(422, "Enter a search phrase.")
        vector = self.model.encode([text])[0]
        candidates = self.store.search(session.owner, self.model.key, vector, min(query.limit * 5, 100))
        hits = []
        partial = False
        deadline = time.monotonic() + 20
        for candidate in candidates:
            if time.monotonic() >= deadline:
                partial = True
                break
            score = max(-1, min(1, 1 - float(candidate["distance"])))
            if score < self.minimum_score:
                break
            try:
                latest = session.source(candidate["file_id"])
                if not matches(Source.model_validate(candidate["source"]), latest):
                    self.store.delete(session.owner, candidate["file_id"], candidate["content_hash"])
                    continue
            except SearchError as error:
                if error.status in {403, 404, 409}:
                    self.store.delete(session.owner, candidate["file_id"], candidate["content_hash"])
                    continue
                raise
            passage = candidate["passage"]
            hits.append({"file_id": candidate["file_id"], "name": latest.name,
                         "source": latest.model_dump(), "score": score,
                         "snippet": passage["text"], "location": passage["location"],
                         "page_number": passage["page_number"], "method": passage["method"],
                         "needs_review": passage["needs_review"]})
            if len(hits) >= query.limit:
                break
        return {"results": hits, "partial": partial, "model_key": self.model.key}
