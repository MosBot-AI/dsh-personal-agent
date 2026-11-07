/** Content-free memory ownership, exclusions, and replay receipts. */
export const migration009 = `
  CREATE TABLE memory_commands (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    actor_digest TEXT NOT NULL CHECK (length(actor_digest) = 64 AND actor_digest NOT GLOB '*[^0-9a-f]*'),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    receipt TEXT NOT NULL CHECK (length(CAST(receipt AS BLOB)) <= 32768 AND json_type(receipt) IS 'object'
      AND (receipt ->> '$.commandId') IS command_id AND (receipt ->> '$.access.ownerId') IS owner_id
      AND (receipt ->> '$.access.profileId') IS profile_id AND json_type(receipt, '$.previous.value') IS NULL
      AND json_type(receipt, '$.proposed.value') IS NULL),
    UNIQUE (owner_id, profile_id, client_id, command_id),
    UNIQUE (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE memory_sources (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('profile', 'project', 'task')),
    scope_id TEXT NOT NULL CHECK ((scope_kind = 'profile') = (scope_id = '')),
    command_ref TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    occurred_at TEXT NOT NULL CHECK (occurred_at >= verified_at),
    UNIQUE (id, owner_id, profile_id, scope_kind, scope_id),
    FOREIGN KEY (command_ref, owner_id, profile_id) REFERENCES memory_commands (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE memory_ledger (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('profile', 'project', 'task')),
    scope_id TEXT NOT NULL CHECK ((scope_kind = 'profile') = (scope_id = '')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'superseded', 'forgotten')),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    digest TEXT CHECK (digest IS NULL OR (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')),
    source_id TEXT NOT NULL UNIQUE,
    valid_from TEXT NOT NULL,
    valid_until TEXT CHECK (valid_until IS NULL OR valid_until >= valid_from),
    superseded_by TEXT,
    forgotten_at TEXT CHECK (forgotten_at IS NULL OR forgotten_at >= valid_from),
    pending_command TEXT,
    CHECK ((state = 'forgotten') = (digest IS NULL)),
    CHECK ((state = 'forgotten') = (forgotten_at IS NOT NULL)),
    CHECK ((state = 'superseded') = (superseded_by IS NOT NULL)),
    CHECK (superseded_by IS NULL OR superseded_by <> record_id),
    CHECK ((state IN ('pending', 'active')) = (revision = 1)),
    CHECK (state <> 'pending' OR pending_command IS NOT NULL),
    CHECK (state <> 'active' OR pending_command IS NULL),
    UNIQUE (owner_id, profile_id, scope_kind, scope_id, record_id),
    FOREIGN KEY (source_id, owner_id, profile_id, scope_kind, scope_id)
      REFERENCES memory_sources (id, owner_id, profile_id, scope_kind, scope_id),
    FOREIGN KEY (pending_command, owner_id, profile_id) REFERENCES memory_commands (id, owner_id, profile_id),
    FOREIGN KEY (owner_id, profile_id, scope_kind, scope_id, superseded_by)
      REFERENCES memory_ledger (owner_id, profile_id, scope_kind, scope_id, record_id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE INDEX memory_ledger_active_recent ON memory_ledger (owner_id, profile_id, scope_kind, scope_id, sequence DESC)
    WHERE state = 'active';
  CREATE INDEX memory_ledger_pending ON memory_ledger (pending_command) WHERE pending_command IS NOT NULL;
`
