/** Durable, exact-action approvals and one-shot claims for existing prepared effects. */
export const migration002 = `
  CREATE UNIQUE INDEX effects_exact_attempt ON effects (operation_id, task_id, attempt_id, generation);

  CREATE TABLE action_proposals (
    operation_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    account_verified_at TEXT NOT NULL CHECK (length(account_verified_at) > 0),
    canonical TEXT NOT NULL CHECK (json_type(canonical) IS 'object'),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    UNIQUE (operation_id, owner_id, profile_id, task_id, attempt_id, generation, digest),
    FOREIGN KEY (operation_id, task_id, attempt_id, generation)
      REFERENCES effects (operation_id, task_id, attempt_id, generation),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id)
  ) STRICT;

  CREATE TABLE action_approvals (
    request_id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text'
      AND (record ->> '$.id') IS request_id AND (record ->> '$.kind') IS 'approval'),
    client_id TEXT NOT NULL CHECK (length(client_id) > 0),
    session_id TEXT NOT NULL CHECK (length(session_id) > 0),
    device_id TEXT NOT NULL CHECK (length(device_id) > 0),
    device_verified_at TEXT NOT NULL CHECK (length(device_verified_at) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
      AND (record ->> '$.status') IS status),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    task_id TEXT GENERATED ALWAYS AS (record ->> '$.taskId') STORED NOT NULL
      CHECK (json_type(record, '$.taskId') IS 'text'),
    attempt_id TEXT GENERATED ALWAYS AS (record ->> '$.attemptId') STORED NOT NULL
      CHECK (json_type(record, '$.attemptId') IS 'text'),
    generation INTEGER GENERATED ALWAYS AS (record ->> '$.generation') STORED NOT NULL
      CHECK (json_type(record, '$.generation') IS 'integer' AND generation BETWEEN 0 AND 9007199254740991),
    digest TEXT GENERATED ALWAYS AS (record ->> '$.action.payloadDigest') STORED NOT NULL
      CHECK (json_type(record, '$.action.payloadDigest') IS 'text'),
    UNIQUE (request_id, operation_id, owner_id, profile_id, status),
    FOREIGN KEY (operation_id, owner_id, profile_id, task_id, attempt_id, generation, digest)
      REFERENCES action_proposals (operation_id, owner_id, profile_id, task_id, attempt_id, generation, digest)
  ) STRICT;

  CREATE TABLE action_grants (
    grant_id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    expired_at TEXT,
    record TEXT NOT NULL CHECK (json_type(record, '$.id') IS 'text'
      AND (record ->> '$.id') IS grant_id
      AND (record ->> '$.approvalEvidence.requestId') IS request_id),
    owner_id TEXT GENERATED ALWAYS AS (record ->> '$.ownerId') STORED NOT NULL
      CHECK (json_type(record, '$.ownerId') IS 'text'),
    profile_id TEXT GENERATED ALWAYS AS (record ->> '$.profileId') STORED NOT NULL
      CHECK (json_type(record, '$.profileId') IS 'text'),
    approval_status TEXT GENERATED ALWAYS AS ('approved') VIRTUAL,
    UNIQUE (grant_id, operation_id),
    FOREIGN KEY (request_id, operation_id, owner_id, profile_id, approval_status)
      REFERENCES action_approvals (request_id, operation_id, owner_id, profile_id, status)
  ) STRICT;

  CREATE TABLE action_dispatches (
    operation_id TEXT PRIMARY KEY NOT NULL,
    grant_id TEXT NOT NULL UNIQUE,
    claimed_at TEXT NOT NULL CHECK (length(claimed_at) > 0),
    FOREIGN KEY (operation_id) REFERENCES action_proposals (operation_id),
    FOREIGN KEY (grant_id, operation_id) REFERENCES action_grants (grant_id, operation_id)
  ) STRICT;
`
