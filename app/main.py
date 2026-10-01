from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.extraction import FILEWISE_ORIGIN
from app.api.extraction import router as extraction_router
from app.core.config import get_settings

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Backend API for the Multimodal Smart File Organizer.",
)

# Browser requests are restricted to the shared Filewise extension identity.
# The endpoint also checks Origin and its custom header for non-preflight requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FILEWISE_ORIGIN],
    allow_methods=["POST"],
    allow_headers=["Content-Type", "X-Filewise-Request"],
)
app.include_router(extraction_router)


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    """Return a small service description for humans and simple clients."""
    return {
        "name": settings.app_name,
        "status": "running",
        "docs": "/docs",
    }


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    """Health endpoint used by tests, containers, and future monitoring."""
    return {"status": "ok"}
