/** Owner-versioned attention policy, exact admission receipts, and coalesced progress. */
export const migration006Attention = `
  CREATE TABLE attention_policies (
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    record TEXT NOT NULL CHECK (json_type(record) IS 'object' AND (record ->> '$.version') IS version),
    PRIMARY KEY (owner_id, profile_id, version)
  ) STRICT;

  CREATE TABLE attention_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    source_instance_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    external_revision TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('progress', 'result', 'blocker', 'approval', 'query', 'reminder', 'proactive')),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    record TEXT NOT NULL CHECK (
      (record ->> '$.id') IS id AND (record ->> '$.category') IS category AND (record ->> '$.taskId') IS task_id
      AND (record ->> '$.attemptId') IS attempt_id AND (record ->> '$.generation') IS generation
      AND (record ->> '$.source.sourceInstanceId') IS source_instance_id
      AND (record ->> '$.source.externalEventId') IS external_event_id
      AND (record ->> '$.source.externalRevision') IS external_revision
    ),
    delivery_id TEXT,
    reserved_at TEXT,
    claimed_at TEXT,
    claim_reason TEXT,
    CHECK ((reserved_at IS NOT NULL) = ((record ->> '$.action') IS 'reserved')),
    CHECK (reserved_at IS NULL OR delivery_id IS NOT NULL),
    CHECK (claimed_at IS NULL OR (reserved_at IS NOT NULL AND claimed_at >= reserved_at)),
    UNIQUE (owner_id, profile_id, source_instance_id, external_event_id, external_revision, category),
    UNIQUE (id, owner_id, profile_id, task_id),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation),
    FOREIGN KEY (delivery_id) REFERENCES outbox (id)
  ) STRICT;

  CREATE UNIQUE INDEX attention_reservation_delivery ON attention_decisions (delivery_id) WHERE reserved_at IS NOT NULL;
  CREATE INDEX attention_decisions_scope ON attention_decisions (owner_id, profile_id);
  CREATE INDEX attention_reservations_owner ON attention_decisions (owner_id, reserved_at) WHERE reserved_at IS NOT NULL;
  CREATE INDEX attention_suppressions_scope ON attention_decisions (owner_id, profile_id, (record ->> '$.at'))
    WHERE (record ->> '$.action') = 'suppressed';

  CREATE TABLE attention_progress (
    task_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (decision_id, owner_id, profile_id, task_id) REFERENCES attention_decisions (id, owner_id, profile_id, task_id)
  ) STRICT;

  CREATE INDEX attention_progress_scope ON attention_progress (owner_id, profile_id);
`
