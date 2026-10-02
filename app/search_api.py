"""Separate hosted search app. The local extraction API is not exposed here."""

import os
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from threading import BoundedSemaphore, Lock

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.api.extraction import FILEWISE_ORIGIN
from app.retrieval.drive import DriveSession, SearchError
from app.retrieval.models import Empty, Forget, IndexDocument, Query

MAX_BODY = 1_000_000


class RateLimit:
    def __init__(self):
        self.windows = OrderedDict()
        self.lock = Lock()

    def check(self, owner, operation):
        now = int(time.monotonic() // 60)
        key = (owner, operation)
        with self.lock:
            previous, count = self.windows.get(key, (now, 0))
            count = count if previous == now else 0
            if count >= (10 if operation == "index" else 60):
                raise SearchError(429, "Search request limit reached. Try again in a minute.")
            self.windows[key] = (now, count + 1)
            self.windows.move_to_end(key)
            if len(self.windows) > 4096:
                self.windows.popitem(last=False)


def create_app(service=None, session_factory=DriveSession):
    @asynccontextmanager
    async def lifespan(application):
        if application.state.service is None:
            from app.retrieval.model import MiniLM
            from app.retrieval.service import SearchService
            from app.retrieval.store import VectorStore

            url = os.environ.get("SEARCH_DATABASE_URL", "")
            if not url:
                raise RuntimeError("SEARCH_DATABASE_URL must reference the search runtime database role.")
            store = VectorStore(url)
            await run_in_threadpool(store.ready)
            model = await run_in_threadpool(MiniLM)
            application.state.service = SearchService(store, model)
        yield

    application = FastAPI(title="Filewise hosted text search", version="1.0.0",
                          docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    application.state.service = service
    application.add_middleware(CORSMiddleware, allow_origins=[FILEWISE_ORIGIN],
                               allow_methods=["POST"],
                               allow_headers=["Authorization", "Content-Type", "X-Filewise-Request"])
    rate = RateLimit()
    slots = BoundedSemaphore(8)

    @application.exception_handler(SearchError)
    async def search_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=error.status,
                            headers={"Cache-Control": "no-store"})

    @application.get("/health")
    async def health():
        return {"status": "ok"}

    async def handle(request, contract, operation):
        if request.headers.get("origin") != FILEWISE_ORIGIN:
            raise SearchError(403, "Only the configured Filewise extension may use this API.")
        if request.headers.get("x-filewise-request") != "search-v1":
            raise SearchError(403, "A Filewise search request is required.")
        if request.url.scheme != "https" and os.environ.get("SEARCH_ALLOW_HTTP") != "true":
            raise SearchError(400, "Hosted search requires HTTPS.")
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer ") or not 1 <= len(header[7:]) <= 4096:
            raise SearchError(401, "Connect Google Drive to use search.")
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise SearchError(415, "Search requests must use JSON.")
        if not slots.acquire(blocking=False):
            raise SearchError(503, "Search is busy. Try again shortly.")
        session = None
        try:
            body = bytearray()
            async for block in request.stream():
                body.extend(block)
                if len(body) > MAX_BODY:
                    raise SearchError(413, "Search request is too large; split the document.")
            try:
                payload = contract.model_validate_json(bytes(body))
            except ValidationError:
                # Validation errors can contain submitted document text; do not echo it.
                raise SearchError(422, "Invalid search request. Check text, query and file limits.") from None
            session = session_factory(header[7:])
            owner = await run_in_threadpool(session.authenticate)
            rate.check(owner, operation)
            active = application.state.service
            if active is None:
                raise SearchError(503, "Search is starting. Try again shortly.")

            def execute():
                if operation == "index":
                    return active.index(session, payload)
                if operation == "query":
                    return active.query(session, payload)
                if operation == "forget":
                    return {"deleted": active.store.delete(owner, payload.file_id)}
                return {"indexed_files": len(active.store.status(owner, active.model.key)),
                        "model_key": active.model.key}

            try:
                result = await run_in_threadpool(execute)
            except SearchError:
                raise
            except ValueError:
                raise SearchError(422, "Text exceeds search limits. Shorten the query or split the file.") from None
            except Exception:  # noqa: BLE001 -- redact all backend failures at the API boundary
                # Do not expose database addresses, SQL parameters, passages or tokens.
                raise SearchError(503, "The search service is unavailable. Retry shortly.") from None
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        finally:
            if session:
                session.close()
            slots.release()

    @application.post("/v1/search/index")
    async def index(request: Request):
        return await handle(request, IndexDocument, "index")

    @application.post("/v1/search/query")
    async def query(request: Request):
        return await handle(request, Query, "query")

    @application.post("/v1/search/status")
    async def status(request: Request):
        return await handle(request, Empty, "status")

    @application.post("/v1/search/forget")
    async def forget(request: Request):
        return await handle(request, Forget, "forget")

    return application


app = create_app()
