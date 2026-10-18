-- Copied from eva v0.3.0 (khang859/eva 6e8d341), src/session.rs VIEWS.
CREATE VIEW transcript_v1 AS
SELECT
    sessions.uuid AS session_id,
    records.id AS id,
    records.created_at AS created_at,
    records.kind AS kind,
    records.content AS content,
    records.calls AS calls,
    records.call_id AS call_id,
    records.status AS status,
    records.agent AS agent,
    records.parent_call AS parent_call,
    records.verdict AS verdict,
    records.tokens AS tokens,
    records.prompt_tokens AS prompt_tokens,
    records.completion_tokens AS completion_tokens,
    records.cached_tokens AS cached_tokens,
    records.cost_nanos / 1e9 AS cost
FROM records JOIN sessions ON sessions.id = records.session_id;

CREATE VIEW sessions_v1 AS
SELECT
    uuid AS id,
    id AS number,
    name,
    created_at,
    updated_at,
    model,
    cwd,
    title
FROM sessions;
