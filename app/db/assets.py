from __future__ import annotations

import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from app.ingestion.storage import StoredUpload


def _connect(database_path: str) -> sqlite3.Connection:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_asset_database(database_path: str) -> None:
    with _connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assets (
                asset_id TEXT PRIMARY KEY,
                original_filename TEXT NOT NULL,
                extension TEXT NOT NULL,
                detected_media_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets (sha256)")


def create_asset(database_path: str, upload: StoredUpload) -> dict[str, object]:
    created_at = datetime.now(timezone.utc).isoformat()
    row = {**asdict(upload), "created_at": created_at}

    with _connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO assets (
                asset_id, original_filename, extension, detected_media_type,
                size_bytes, sha256, storage_path, created_at
            )
            VALUES (
                :asset_id, :original_filename, :extension, :detected_media_type,
                :size_bytes, :sha256, :storage_path, :created_at
            )
            """,
            row,
        )

    return row


def get_asset(database_path: str, asset_id: str) -> dict[str, object] | None:
    with _connect(database_path) as connection:
        result = connection.execute(
            """
            SELECT asset_id, original_filename, extension, detected_media_type,
                   size_bytes, sha256, storage_path, created_at
            FROM assets
            WHERE asset_id = ?
            """,
            (asset_id,),
        ).fetchone()

    return dict(result) if result else None
