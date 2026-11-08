/** Shared inference quotas and one-use claims bound to Core budget reservations. */
export const migration013 = `
  CREATE TABLE inference_attempts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    task_attempt_id TEXT NOT NULL REFERENCES attempts(id),
    generation INTEGER NOT NULL,
    decision_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    previous_id TEXT REFERENCES inference_attempts(id),
    chain_id TEXT NOT NULL,
    fence_digest TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9),
    deployment_id TEXT NOT NULL,
    deployment_revision INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    bucket_id TEXT NOT NULL,
    bucket_revision INTEGER NOT NULL,
    budget_id TEXT UNIQUE REFERENCES budget_reservations(id) DEFERRABLE INITIALLY DEFERRED,
    status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'failed', 'interrupted', 'denied')),
    partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
    failure TEXT CHECK (failure IS NULL OR json_type(failure) IS 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, task_attempt_id, generation, decision_id),
    UNIQUE (task_id, task_attempt_id, generation, series_id),
    UNIQUE (chain_id, ordinal),
    CHECK ((budget_id IS NULL) = (status = 'denied')),
    CHECK (status <> 'denied' OR (partial = 0 AND failure IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX inference_single_stream ON inference_attempts(task_id) WHERE status = 'streaming';
  CREATE INDEX inference_quota_usage ON inference_attempts(owner_id, account_id, bucket_id, created_at);

  CREATE TABLE inference_quota_observations (
    owner_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    bucket_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record) IS 'object'),
    PRIMARY KEY (owner_id, account_id, bucket_id)
  ) STRICT;

  CREATE TABLE inference_quota_blocks (
    owner_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    bucket_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('rate-limit', 'quota')),
    since TEXT NOT NULL,
    next_check_at TEXT,
    PRIMARY KEY (owner_id, account_id, bucket_id)
  ) STRICT;
`
