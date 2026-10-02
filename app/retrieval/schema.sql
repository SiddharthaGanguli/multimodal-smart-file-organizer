CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS filewise_search_documents (
    owner_id text NOT NULL,
    file_id text NOT NULL,
    model_key text NOT NULL,
    source jsonb NOT NULL,
    content_hash text NOT NULL,
    needs_review boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, file_id, model_key)
);

CREATE TABLE IF NOT EXISTS filewise_search_chunks (
    owner_id text NOT NULL,
    file_id text NOT NULL,
    model_key text NOT NULL,
    ordinal integer NOT NULL,
    passage jsonb NOT NULL,
    embedding vector(384) NOT NULL,
    PRIMARY KEY (owner_id, file_id, model_key, ordinal),
    FOREIGN KEY (owner_id, file_id, model_key)
        REFERENCES filewise_search_documents ON DELETE CASCADE
);

ALTER TABLE filewise_search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE filewise_search_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE filewise_search_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE filewise_search_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS filewise_owner ON filewise_search_documents;
CREATE POLICY filewise_owner ON filewise_search_documents
    USING (owner_id = current_setting('filewise.owner_id', true))
    WITH CHECK (owner_id = current_setting('filewise.owner_id', true));
DROP POLICY IF EXISTS filewise_owner ON filewise_search_chunks;
CREATE POLICY filewise_owner ON filewise_search_chunks
    USING (owner_id = current_setting('filewise.owner_id', true))
    WITH CHECK (owner_id = current_setting('filewise.owner_id', true));

-- Exact cosine search first: owner/model predicates apply before ranking, with
-- no approximate-index recall loss under selective permission filtering.
