-- Copied from eva v0.3.0 (khang859/eva 6e8d341), src/session.rs MIGRATIONS, in order.
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    title TEXT NOT NULL
);
CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'summary')),
    content TEXT NOT NULL,
    tokens INTEGER
);
CREATE INDEX records_by_session ON records (session_id, id);

-- A deleted conversation's number is never given to another, so that
-- one written down to resume later cannot lead to the wrong one.
CREATE TABLE numbered_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    title TEXT NOT NULL
);
INSERT INTO numbered_sessions SELECT id, created_at, updated_at, model, title FROM sessions;
DROP TABLE sessions;
ALTER TABLE numbered_sessions RENAME TO sessions;

-- The tools the model calls, and what came of them.
CREATE TABLE tooled_records (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    kind TEXT NOT NULL
        CHECK (kind IN ('question', 'answer', 'result', 'summary', 'checkpoint')),
    content TEXT NOT NULL,
    tokens INTEGER,
    -- The calls an answer makes, as JSON.
    calls TEXT CHECK (calls IS NULL OR kind = 'answer'),
    -- The call a result answers, and how it went.
    call_id TEXT,
    status TEXT
        CHECK (status IN ('ok', 'error', 'declined', 'stopped', 'not_run', 'interrupted')),
    CHECK ((kind = 'result') = (call_id IS NOT NULL AND status IS NOT NULL))
);
INSERT INTO tooled_records (id, session_id, kind, content, tokens)
    SELECT id, session_id, kind, content, tokens FROM records;
DROP TABLE records;
ALTER TABLE tooled_records RENAME TO records;
CREATE INDEX records_by_session ON records (session_id, id);

-- What the model thought before an answer, as JSON, to send it back.
ALTER TABLE records ADD COLUMN reasoning TEXT CHECK (reasoning IS NULL OR kind = 'answer');

-- The pages an answer cites, as JSON, to show them again.
ALTER TABLE records ADD COLUMN citations TEXT CHECK (citations IS NULL OR kind = 'answer');

-- How many times the web was searched, and pages fetched, for an
-- answer, to tell again.
ALTER TABLE records ADD COLUMN searches INTEGER CHECK (searches IS NULL OR kind = 'answer');
ALTER TABLE records ADD COLUMN fetches INTEGER CHECK (fetches IS NULL OR kind = 'answer');

-- Every message sent, for the up arrow to bring back in the directory
-- it was sent from. It is kept apart from the conversations, so that
-- deleting one leaves what was typed in it.
CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    directory TEXT NOT NULL,
    line TEXT NOT NULL
);
CREATE INDEX history_by_directory ON history (directory, id);

-- What the model and the user asked to be remembered, everywhere or in
-- one project. It is kept apart from the conversations, so that
-- deleting one leaves what was remembered in it.
CREATE TABLE memories (
    -- A forgotten memory's number is never given to another, so that
    -- one written down to forget later cannot lead to the wrong one.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    -- The root of the project a project memory is for.
    project TEXT,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    -- Who saved it: the model, or the user with /remember.
    source TEXT NOT NULL CHECK (source IN ('model', 'user')),
    saved_at INTEGER NOT NULL,
    CHECK ((scope = 'project') = (project IS NOT NULL))
);
CREATE INDEX memories_by_project ON memories (project, id);

-- The images a question was asked with, or a tool came back with, as
-- JSON, to send them again.
ALTER TABLE records ADD COLUMN images TEXT
    CHECK (images IS NULL OR kind IN ('question', 'result'));

-- The goals set with /goal, each verdict on whether one was met, and
-- what the model was told to carry on towards one with.
CREATE TABLE goaled_records (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
        'question', 'answer', 'result', 'summary', 'checkpoint',
        'goal', 'verdict', 'goal_cleared', 'continuation'
    )),
    content TEXT NOT NULL,
    tokens INTEGER,
    calls TEXT CHECK (calls IS NULL OR kind = 'answer'),
    call_id TEXT,
    status TEXT
        CHECK (status IN ('ok', 'error', 'declined', 'stopped', 'not_run', 'interrupted')),
    reasoning TEXT CHECK (reasoning IS NULL OR kind = 'answer'),
    citations TEXT CHECK (citations IS NULL OR kind = 'answer'),
    searches INTEGER CHECK (searches IS NULL OR kind = 'answer'),
    fetches INTEGER CHECK (fetches IS NULL OR kind = 'answer'),
    images TEXT CHECK (images IS NULL OR kind IN ('question', 'result')),
    -- What a verdict found, which only a verdict has.
    verdict TEXT CHECK (verdict IN ('met', 'not_met', 'impossible')),
    CHECK ((kind = 'result') = (call_id IS NOT NULL AND status IS NOT NULL)),
    CHECK ((kind = 'verdict') = (verdict IS NOT NULL))
);
INSERT INTO goaled_records
    (id, session_id, kind, content, tokens, calls, call_id, status,
     reasoning, citations, searches, fetches, images)
    SELECT id, session_id, kind, content, tokens, calls, call_id, status,
           reasoning, citations, searches, fetches, images
    FROM records;
DROP TABLE records;
ALTER TABLE goaled_records RENAME TO records;
CREATE INDEX records_by_session ON records (session_id, id);

-- What the subagents the model started said and did, each record
-- marked with the kind of agent and the call that started it.
ALTER TABLE records ADD COLUMN agent TEXT;
ALTER TABLE records ADD COLUMN parent_call TEXT
    CHECK ((agent IS NULL) = (parent_call IS NULL));

-- An id for each conversation that is known before anything of it is
-- saved, which hooks are told, random so that no two are the same
-- wherever they were started.
ALTER TABLE sessions ADD COLUMN uuid TEXT;
UPDATE sessions SET uuid = lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
    || substr(hex(randomblob(2)), 2) || '-'
    || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2)
    || '-' || hex(randomblob(6))
);
CREATE UNIQUE INDEX sessions_by_uuid ON sessions (uuid);

-- When each record was saved, the directory each conversation was
-- held in, and the name it was given, for other programs to read.
ALTER TABLE records ADD COLUMN created_at INTEGER;
ALTER TABLE sessions ADD COLUMN cwd TEXT;
ALTER TABLE sessions ADD COLUMN name TEXT;

-- The instructions a conversation was held with, from --instructions.
ALTER TABLE sessions ADD COLUMN instructions TEXT;

-- What each answer took up and cost, as the server told, and what each
-- conversation did in all, subagents, checks of the goal, and summaries
-- included. Costs are in billionths of a dollar, so that adding them
-- up loses nothing.
ALTER TABLE records ADD COLUMN prompt_tokens INTEGER
    CHECK (prompt_tokens IS NULL OR kind = 'answer');
ALTER TABLE records ADD COLUMN completion_tokens INTEGER
    CHECK (completion_tokens IS NULL OR kind = 'answer');
ALTER TABLE records ADD COLUMN cached_tokens INTEGER
    CHECK (cached_tokens IS NULL OR kind = 'answer');
ALTER TABLE records ADD COLUMN cost_nanos INTEGER
    CHECK (cost_nanos IS NULL OR kind = 'answer');
ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN completion_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN cached_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN cost_nanos INTEGER;
