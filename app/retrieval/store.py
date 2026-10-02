"""Transactional pgvector index with explicit ownership filters and forced RLS."""

import math
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.retrieval.drive import SearchError
from app.retrieval.model import DIMENSIONS


def vector_literal(vector):
    if len(vector) != DIMENSIONS or not all(math.isfinite(x) for x in vector):
        raise ValueError("Invalid embedding dimensions or values")
    return "[" + ",".join(str(float(x)) for x in vector) + "]"


class VectorStore:
    def __init__(self, url):
        self.url = url

    @contextmanager
    def connection(self, owner):
        with psycopg.connect(self.url, connect_timeout=10, row_factory=dict_row) as conn:
            conn.execute("SELECT set_config('filewise.owner_id', %s, true)", (owner,))
            conn.execute("SET LOCAL statement_timeout = '15s'")
            yield conn

    def ready(self):
        with self.connection("") as conn:
            role = conn.execute("SELECT rolsuper, rolbypassrls FROM pg_roles "
                                "WHERE rolname=current_user").fetchone()
            if role["rolsuper"] or role["rolbypassrls"]:
                raise RuntimeError("Search requires a non-superuser database role without BYPASSRLS.")
            conn.execute("SELECT 1 FROM filewise_search_documents LIMIT 1")
            conn.execute("SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector")

    def get(self, owner, file_id, model):
        with self.connection(owner) as conn:
            return conn.execute("SELECT * FROM filewise_search_documents "
                                "WHERE owner_id=%s AND file_id=%s AND model_key=%s",
                                (owner, file_id, model)).fetchone()

    def replace(self, owner, document, model, digest, passages, vectors):
        if len(passages) != len(vectors):
            raise ValueError("Missing chunk vectors")
        with self.connection(owner) as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (owner,))
            existing = conn.execute("SELECT count(*) AS n FROM filewise_search_documents "
                                    "WHERE owner_id=%s AND file_id<>%s",
                                    (owner, document.file_id)).fetchone()["n"]
            count = conn.execute("SELECT count(*) AS n FROM filewise_search_chunks "
                                 "WHERE owner_id=%s AND file_id<>%s",
                                 (owner, document.file_id)).fetchone()["n"]
            if existing >= 1000 or count + len(passages) > 20_000:
                raise SearchError(409, "Search index limit reached. Remove indexed files first.")
            # Replace every model version for this file to avoid abandoned index growth.
            conn.execute("DELETE FROM filewise_search_documents WHERE owner_id=%s AND file_id=%s",
                         (owner, document.file_id))
            conn.execute("INSERT INTO filewise_search_documents "
                         "(owner_id,file_id,model_key,source,content_hash,needs_review) "
                         "VALUES (%s,%s,%s,%s,%s,%s)",
                         (owner, document.file_id, model, Jsonb(document.source.model_dump()), digest,
                          any(p["needs_review"] for p in passages)))
            with conn.cursor() as cursor:
                cursor.executemany("INSERT INTO filewise_search_chunks "
                                   "(owner_id,file_id,model_key,ordinal,passage,embedding) "
                                   "VALUES (%s,%s,%s,%s,%s,%s::vector)",
                                   [(owner, document.file_id, model, i, Jsonb(p), vector_literal(v))
                                    for i, (p, v) in enumerate(zip(passages, vectors, strict=True))])

    def search(self, owner, model, vector, limit):
        with self.connection(owner) as conn:
            return conn.execute("""
                WITH ranked AS (
                    SELECT c.file_id, c.ordinal, c.passage, d.source, d.content_hash,
                           d.needs_review, (c.embedding <=> %s::vector) AS distance,
                           row_number() OVER (PARTITION BY c.file_id ORDER BY
                               c.embedding <=> %s::vector, c.ordinal) AS row_number
                    FROM filewise_search_chunks c
                    JOIN filewise_search_documents d USING (owner_id,file_id,model_key)
                    WHERE c.owner_id=%s AND d.owner_id=%s AND c.model_key=%s
                )
                SELECT * FROM ranked WHERE row_number=1
                ORDER BY distance, file_id LIMIT %s
                """, (vector_literal(vector), vector_literal(vector), owner, owner, model,
                      limit)).fetchall()

    def delete(self, owner, file_id=None, digest=None):
        with self.connection(owner) as conn:
            sql = "DELETE FROM filewise_search_documents WHERE owner_id=%s"
            args = [owner]
            if file_id:
                sql += " AND file_id=%s"
                args.append(file_id)
            if digest:
                sql += " AND content_hash=%s"
                args.append(digest)
            return conn.execute(sql, args).rowcount

    def status(self, owner, model):
        with self.connection(owner) as conn:
            rows = conn.execute("SELECT file_id, source, content_hash, model_key "
                                "FROM filewise_search_documents WHERE owner_id=%s "
                                "ORDER BY updated_at DESC LIMIT 1000", (owner,)).fetchall()
        return [{"file_id": r["file_id"], "source": r["source"],
                 "current_model": r["model_key"] == model} for r in rows]
