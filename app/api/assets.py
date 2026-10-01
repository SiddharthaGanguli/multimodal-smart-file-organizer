from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.db.assets import create_asset, get_asset, initialize_asset_database
from app.ingestion.storage import UploadValidationError, store_upload

router = APIRouter(prefix="/api/v1/assets", tags=["assets"])


def _public_asset(asset: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in asset.items()
        if key != "storage_path"
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def upload_asset(file: UploadFile = File(...)) -> dict[str, object]:
    settings = get_settings()
    initialize_asset_database(settings.asset_database_path)

    try:
        stored = store_upload(
            upload=file,
            storage_dir=settings.storage_dir,
            max_upload_bytes=settings.max_upload_bytes,
        )
    except UploadValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    asset = create_asset(settings.asset_database_path, stored)
    return _public_asset(asset)


@router.get("/{asset_id}")
def read_asset(asset_id: str) -> dict[str, object]:
    settings = get_settings()
    initialize_asset_database(settings.asset_database_path)
    asset = get_asset(settings.asset_database_path, asset_id)

    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found.")

    return _public_asset(asset)


@router.get("/{asset_id}/content")
def read_asset_content(asset_id: str) -> FileResponse:
    """Return the preserved original.

    Authentication/ownership enforcement is intentionally deferred until the
    authentication milestone. This endpoint must not be exposed publicly before then.
    """
    settings = get_settings()
    initialize_asset_database(settings.asset_database_path)
    asset = get_asset(settings.asset_database_path, asset_id)

    if asset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found.")

    path = Path(str(asset["storage_path"]))
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="The asset record exists but the original file is missing.",
        )

    return FileResponse(
        path=path,
        media_type=str(asset["detected_media_type"]),
        filename=str(asset["original_filename"]),
    )
