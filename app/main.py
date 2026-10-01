from fastapi import FastAPI

from app.core.config import get_settings

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Backend API for the Multimodal Smart File Organizer.",
)


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
