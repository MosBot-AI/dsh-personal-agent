/** Initial durable work schema. Indexed identity fields come from the stored records. */
export const migration001 = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    UNIQUE (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    UNIQUE (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    project_id TEXT GENERATED ALWAYS AS (record ->> '$.projectId') STORED NOT NULL
      CHECK (json_type(record, '$.projectId') IS 'text'),
    conversation_id TEXT GENERATED ALWAYS AS (record ->> '$.conversationId') STORED
      CHECK (json_type(record, '$.conversationId') IS NULL OR json_type(record, '$.conversationId') IS 'text'),
    attempt_id TEXT GENERATED ALWAYS AS (record ->> '$.attemptId') STORED NOT NULL
      CHECK (json_type(record, '$.attemptId') IS 'text'),
    version INTEGER GENERATED ALWAYS AS (record ->> '$.version') STORED NOT NULL
      CHECK (json_type(record, '$.version') IS 'integer' AND version BETWEEN 0 AND 9007199254740991),
    generation INTEGER GENERATED ALWAYS AS (record ->> '$.generation') STORED NOT NULL
      CHECK (json_type(record, '$.generation') IS 'integer' AND generation BETWEEN 0 AND 9007199254740991),
    UNIQUE (id, owner_id, profile_id),
    FOREIGN KEY (project_id, owner_id, profile_id) REFERENCES projects (id, owner_id, profile_id),
    FOREIGN KEY (conversation_id, owner_id, profile_id) REFERENCES conversations (id, owner_id, profile_id),
    -- Cancellation advances the Task fence while its current Attempt retains its generation.
    FOREIGN KEY (id, attempt_id) REFERENCES attempts (task_id, id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    task_id TEXT GENERATED ALWAYS AS (record ->> '$.taskId') STORED NOT NULL
      CHECK (json_type(record, '$.taskId') IS 'text'),
    generation INTEGER GENERATED ALWAYS AS (record ->> '$.generation') STORED NOT NULL
      CHECK (json_type(record, '$.generation') IS 'integer' AND generation BETWEEN 0 AND 9007199254740991),
    status TEXT GENERATED ALWAYS AS (record ->> '$.status') STORED NOT NULL
      CHECK (status IN ('queued', 'running', 'waiting', 'paused', 'verifying', 'cancelling', 'completed', 'failed', 'cancelled')),
    UNIQUE (task_id, id),
    UNIQUE (task_id, generation),
    UNIQUE (task_id, id, generation),
    FOREIGN KEY (task_id) REFERENCES tasks (id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE UNIQUE INDEX attempts_one_active ON attempts (task_id)
    WHERE status NOT IN ('completed', 'failed', 'cancelled');

  CREATE TABLE source_events (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    source_instance_id TEXT GENERATED ALWAYS AS (record ->> '$.sourceInstanceId') STORED NOT NULL
      CHECK (json_type(record, '$.sourceInstanceId') IS 'text'),
    external_event_id TEXT GENERATED ALWAYS AS (record ->> '$.externalEventId') STORED NOT NULL
      CHECK (json_type(record, '$.externalEventId') IS 'text'),
    external_revision TEXT GENERATED ALWAYS AS (record ->> '$.externalRevision') STORED NOT NULL
      CHECK (json_type(record, '$.externalRevision') IS 'text'),
    UNIQUE (source_instance_id, external_event_id, external_revision),
    UNIQUE (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE effects (
    operation_id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.operationId') IS 'text' AND (record ->> '$.operationId') IS operation_id),
    task_id TEXT GENERATED ALWAYS AS (record ->> '$.taskId') STORED NOT NULL
      CHECK (json_type(record, '$.taskId') IS 'text'),
    attempt_id TEXT GENERATED ALWAYS AS (record ->> '$.attemptId') STORED NOT NULL
      CHECK (json_type(record, '$.attemptId') IS 'text'),
    generation INTEGER GENERATED ALWAYS AS (record ->> '$.generation') STORED NOT NULL
      CHECK (json_type(record, '$.generation') IS 'integer' AND generation BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation)
  ) STRICT;

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    dedupe_key TEXT GENERATED ALWAYS AS (record ->> '$.dedupeKey') STORED NOT NULL
      CHECK (json_type(record, '$.dedupeKey') IS 'text'),
    UNIQUE (owner_id, profile_id, dedupe_key),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation)
  ) STRICT;

  CREATE TABLE commands (
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    result TEXT NOT NULL CHECK (json_type(result) IS 'object'),
    task_id TEXT NOT NULL,
    PRIMARY KEY (owner_id, client_id, command_id),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE work_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 9007199254740991),
    type TEXT NOT NULL CHECK (length(type) > 0),
    status TEXT NOT NULL CHECK (length(status) > 0),
    occurred_at TEXT NOT NULL,
    source_event_id TEXT,
    UNIQUE (task_id, version),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id) REFERENCES attempts (task_id, id),
    FOREIGN KEY (source_event_id, owner_id, profile_id) REFERENCES source_events (id, owner_id, profile_id)
  ) STRICT;

  CREATE INDEX work_events_by_scope ON work_events (owner_id, profile_id, sequence);
`
