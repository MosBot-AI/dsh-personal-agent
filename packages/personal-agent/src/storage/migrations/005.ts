/** Versioned external event dispositions and exact task subscriptions. */
export const migration005 = `
  CREATE TABLE routing_receipts (
    event_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    policy_version TEXT NOT NULL,
    account_verified_at TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    disposition TEXT NOT NULL CHECK (json_type(disposition) IS 'object'),
    kind TEXT GENERATED ALWAYS AS (disposition ->> '$.kind') STORED NOT NULL
      CHECK (kind IN ('pending', 'queued', 'rejected', 'context', 'assessed', 'routed', 'handback')),
    FOREIGN KEY (event_id, owner_id, profile_id) REFERENCES source_events (id, owner_id, profile_id)
  ) STRICT;

  CREATE INDEX routing_receipts_scope_kind ON routing_receipts (owner_id, profile_id, kind);

  CREATE TABLE routing_subscriptions (
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    source_instance_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('context', 'work')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    policy_version TEXT NOT NULL,
    account_verified_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT CHECK (expires_at IS NULL OR expires_at > updated_at),
    PRIMARY KEY (owner_id, profile_id, source_instance_id, account_id, thread_id, task_id),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id)
  ) STRICT;

  CREATE INDEX routing_subscriptions_enabled ON routing_subscriptions (
    owner_id, profile_id, source_instance_id, account_id, thread_id
  ) WHERE enabled = 1;

  CREATE TABLE routing_deliveries (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES routing_receipts (event_id),
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    cursor TEXT NOT NULL,
    project_id TEXT NOT NULL,
    subscription_version INTEGER NOT NULL CHECK (subscription_version BETWEEN 1 AND 9007199254740991),
    task_version INTEGER NOT NULL CHECK (task_version BETWEEN 1 AND 9007199254740991),
    handback_at TEXT,
    UNIQUE (task_id, attempt_id, generation, cursor),
    FOREIGN KEY (task_id, attempt_id, generation, cursor)
      REFERENCES worker_inputs (task_id, attempt_id, generation, cursor),
    FOREIGN KEY (task_id, task_version) REFERENCES work_events (task_id, version)
  ) STRICT;
`
