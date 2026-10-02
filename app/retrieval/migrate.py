"""Run search schema migration with an administrator connection, then grant the runtime role."""

import os
from pathlib import Path

import psycopg
from psycopg import sql


def migrate(url, runtime_role="filewise_search"):
    with psycopg.connect(url) as conn:
        conn.execute(Path(__file__).with_name("schema.sql").read_text("utf-8"))
        role = conn.execute("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=%s",
                            (runtime_role,)).fetchone()
        if not role or any(role):
            raise ValueError("Create a dedicated runtime role without SUPERUSER or BYPASSRLS first.")
        conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(runtime_role)))
        conn.execute(sql.SQL("GRANT SELECT,INSERT,UPDATE,DELETE ON filewise_search_documents, "
                             "filewise_search_chunks TO {}").format(sql.Identifier(runtime_role)))


if __name__ == "__main__":
    migrate(os.environ["SEARCH_MIGRATION_URL"], os.environ.get("SEARCH_DB_ROLE", "filewise_search"))
    print("Search schema and runtime grants are ready.")
