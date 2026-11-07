/** Scoped compaction checkpoints and monotonic context exclusions. */
export const migration008 = `
  ALTER TABLE worker_inputs ADD COLUMN context_sources TEXT CHECK (
    context_sources IS NULL OR (
      length(CAST(context_sources AS BLOB)) <= 262144 AND json_valid(context_sources)
      AND json_type(context_sources) IS 'array' AND json_array_length(context_sources) <= 128
    )
  );

  CREATE TABLE context_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
    record TEXT NOT NULL CHECK (json_type(record) IS 'object' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL,
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL,
    project_id TEXT GENERATED ALWAYS AS (record ->> '$.projectId') STORED NOT NULL,
    task_id TEXT GENERATED ALWAYS AS (record ->> '$.taskId') STORED NOT NULL,
    attempt_id TEXT GENERATED ALWAYS AS (record ->> '$.attemptId') STORED NOT NULL,
    session_id TEXT GENERATED ALWAYS AS (record ->> '$.sessionId') STORED NOT NULL,
    compaction_id TEXT GENERATED ALWAYS AS (record ->> '$.compactionId') STORED NOT NULL,
    generation INTEGER GENERATED ALWAYS AS (record ->> '$.generation') STORED NOT NULL
      CHECK (json_type(record, '$.generation') IS 'integer' AND generation BETWEEN 0 AND 9007199254740991),
    task_version INTEGER GENERATED ALWAYS AS (record ->> '$.taskVersion') STORED NOT NULL
      CHECK (json_type(record, '$.taskVersion') IS 'integer' AND task_version BETWEEN 0 AND 9007199254740991),
    revision INTEGER GENERATED ALWAYS AS (record ->> '$.revision') STORED NOT NULL
      CHECK (json_type(record, '$.revision') IS 'integer' AND revision BETWEEN 1 AND 9007199254740991),
    UNIQUE (task_id, session_id, compaction_id),
    UNIQUE (task_id, attempt_id, generation, session_id, revision),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (project_id, owner_id, profile_id) REFERENCES projects (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation),
    FOREIGN KEY (task_id, task_version) REFERENCES work_events (task_id, version)
  ) STRICT;

  CREATE TABLE context_exclusions (
    task_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('event', 'artifact')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('superseded', 'forgotten')),
    excluded_at TEXT NOT NULL,
    PRIMARY KEY (task_id, subject_kind, subject_id),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id)
  ) STRICT;

  CREATE INDEX context_work_event_source ON work_events (task_id, source_event_id) WHERE source_event_id IS NOT NULL;
  CREATE INDEX context_source_scope_scan ON source_events (owner_id, profile_id);
  CREATE INDEX context_artifact_task_scan ON artifacts (task_id, owner_id, profile_id);
`
