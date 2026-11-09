/** A held media lease outlives the process and ambiguous backend submissions. */
export const migration016 = `
  CREATE TABLE media_jobs (
    sequence INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    generation INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    request TEXT NOT NULL CHECK (json_type(request) IS 'object'),
    provider TEXT NOT NULL CHECK (json_type(provider) IS 'object'),
    prepared TEXT CHECK (prepared IS NULL OR json_type(prepared) IS 'object'),
    outputs TEXT CHECK (outputs IS NULL OR json_type(outputs) IS 'array'),
    state TEXT NOT NULL CHECK (state IN ('queued', 'submitting', 'unknown', 'rendering', 'collecting', 'succeeded', 'failed', 'cancelled')),
    next_try INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    reason TEXT,
    UNIQUE (owner_id, profile_id, task_id, attempt_id, generation, operation_id),
    CHECK ((state = 'succeeded') = (outputs IS NOT NULL)),
    CHECK (state NOT IN ('submitting', 'unknown', 'rendering', 'collecting', 'succeeded') OR prepared IS NOT NULL)
  ) STRICT;
  CREATE UNIQUE INDEX media_single_lease ON media_jobs ((1))
    WHERE state IN ('submitting', 'unknown', 'rendering', 'collecting');
  CREATE INDEX media_fifo ON media_jobs (next_try, sequence) WHERE state = 'queued';
`
