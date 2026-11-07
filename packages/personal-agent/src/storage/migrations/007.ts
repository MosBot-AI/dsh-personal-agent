/** Authoritative Routine intent, native mapping journal and logical occurrences. */
export const migration007 = `
  CREATE TABLE routines (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    revision INTEGER GENERATED ALWAYS AS (record ->> '$.revision') STORED NOT NULL
      CHECK (json_type(record, '$.revision') IS 'integer' AND revision BETWEEN 1 AND 9007199254740991),
    status TEXT GENERATED ALWAYS AS (record ->> '$.status') STORED NOT NULL
      CHECK (status IN ('draft', 'armed', 'paused', 'ended')),
    UNIQUE (id, owner_id, profile_id)
  ) STRICT;

  CREATE INDEX routines_scope ON routines (owner_id, profile_id);
  CREATE INDEX routines_armed ON routines (id) WHERE status = 'armed';

  CREATE TABLE routine_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    routine_id TEXT GENERATED ALWAYS AS (record ->> '$.routineId') STORED NOT NULL,
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL,
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL,
    routine_revision INTEGER GENERATED ALWAYS AS (record ->> '$.routineRevision') STORED NOT NULL
      CHECK (json_type(record, '$.routineRevision') IS 'integer' AND routine_revision BETWEEN 1 AND 9007199254740991),
    intended_at TEXT GENERATED ALWAYS AS (record ->> '$.intendedAt') STORED NOT NULL,
    native_id TEXT GENERATED ALWAYS AS (record ->> '$.nativeId') STORED UNIQUE,
    version INTEGER GENERATED ALWAYS AS (record ->> '$.version') STORED NOT NULL
      CHECK (json_type(record, '$.version') IS 'integer' AND version BETWEEN 1 AND 9007199254740991),
    state TEXT GENERATED ALWAYS AS (record ->> '$.state') STORED NOT NULL
      CHECK (state IN ('intent', 'bound', 'uncertain', 'terminal')),
    UNIQUE (routine_id, routine_revision, intended_at),
    UNIQUE (id, routine_id, owner_id, profile_id, routine_revision),
    FOREIGN KEY (routine_id, owner_id, profile_id) REFERENCES routines (id, owner_id, profile_id)
  ) STRICT;

  CREATE UNIQUE INDEX routine_one_live_mapping ON routine_mappings (routine_id, routine_revision) WHERE state <> 'terminal';

  CREATE TABLE routine_occurrences (
    id TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text' AND (record ->> '$.id') IS id),
    mapping_id TEXT UNIQUE,
    client_id TEXT,
    command_id TEXT,
    routine_id TEXT GENERATED ALWAYS AS (record ->> '$.routineId') STORED NOT NULL,
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL,
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL,
    routine_revision INTEGER GENERATED ALWAYS AS (record ->> '$.routineRevision') STORED NOT NULL
      CHECK (json_type(record, '$.routineRevision') IS 'integer' AND routine_revision BETWEEN 1 AND 9007199254740991),
    intended_at TEXT GENERATED ALWAYS AS (record ->> '$.intendedAt') STORED NOT NULL,
    observed_at TEXT GENERATED ALWAYS AS (record ->> '$.observedAt') STORED NOT NULL,
    kind TEXT GENERATED ALWAYS AS (record ->> '$.kind') STORED NOT NULL CHECK (kind IN ('scheduled', 'manual')),
    source_event_id TEXT GENERATED ALWAYS AS (record ->> '$.sourceEventId') STORED UNIQUE,
    CHECK ((kind = 'scheduled' AND client_id IS NULL AND command_id IS NULL)
      OR (kind = 'manual' AND client_id IS NOT NULL AND command_id IS NOT NULL AND mapping_id IS NULL)),
    FOREIGN KEY (routine_id, owner_id, profile_id) REFERENCES routines (id, owner_id, profile_id),
    FOREIGN KEY (mapping_id, routine_id, owner_id, profile_id, routine_revision)
      REFERENCES routine_mappings (id, routine_id, owner_id, profile_id, routine_revision),
    FOREIGN KEY (source_event_id, owner_id, profile_id) REFERENCES source_events (id, owner_id, profile_id)
  ) STRICT;

  CREATE UNIQUE INDEX routine_scheduled_occurrence ON routine_occurrences (routine_id, routine_revision, intended_at)
    WHERE kind = 'scheduled';
  CREATE UNIQUE INDEX routine_manual_command ON routine_occurrences (owner_id, client_id, command_id)
    WHERE kind = 'manual';
  CREATE INDEX routine_occurrences_scope ON routine_occurrences (owner_id, profile_id, observed_at DESC, id);
`
