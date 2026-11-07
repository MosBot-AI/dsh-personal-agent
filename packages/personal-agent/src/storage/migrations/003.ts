/** Immutable artifact revisions, historical verification and exact delivery routes. */
export const migration003 = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    previous_id TEXT UNIQUE,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    previous_version INTEGER GENERATED ALWAYS AS (version - 1) VIRTUAL,
    record TEXT NOT NULL CHECK (
      json_type(record, '$.artifact.id') IS 'text' AND (record ->> '$.artifact.id') IS id
      AND json_type(record, '$.artifact.ownerId') IS 'text' AND (record ->> '$.artifact.ownerId') IS owner_id
      AND json_type(record, '$.artifact.profileId') IS 'text' AND (record ->> '$.artifact.profileId') IS profile_id
      AND json_type(record, '$.artifact.attemptId') IS 'text' AND (record ->> '$.artifact.attemptId') IS attempt_id
      AND json_type(record, '$.taskId') IS 'text' AND (record ->> '$.taskId') IS task_id
      AND json_type(record, '$.generation') IS 'integer' AND (record ->> '$.generation') IS generation
      AND json_type(record, '$.version') IS 'integer' AND (record ->> '$.version') IS version
      AND (record ->> '$.previousId') IS previous_id
      AND (
        (previous_id IS NULL AND version = 1 AND json_type(record, '$.previousId') IS NULL)
        OR (previous_id IS NOT NULL AND previous_id <> id AND version > 1 AND json_type(record, '$.previousId') IS 'text')
      )
    ),
    content BLOB NOT NULL CHECK (length(content) BETWEEN 1 AND 262144),
    UNIQUE (id, owner_id, profile_id, task_id, version),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation),
    FOREIGN KEY (previous_id, owner_id, profile_id, task_id, previous_version)
      REFERENCES artifacts (id, owner_id, profile_id, task_id, version)
  ) STRICT;

  CREATE UNIQUE INDEX work_events_exact_completion ON work_events (task_id, version, attempt_id, status);

  CREATE TABLE work_verifications (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    completion_status TEXT GENERATED ALWAYS AS ('completed') VIRTUAL,
    record TEXT NOT NULL CHECK (
      json_type(record, '$.taskId') IS 'text' AND (record ->> '$.taskId') IS task_id
      AND json_type(record, '$.attemptId') IS 'text' AND (record ->> '$.attemptId') IS attempt_id
      AND json_type(record, '$.generation') IS 'integer' AND (record ->> '$.generation') IS generation
      AND json_type(record, '$.version') IS 'integer' AND (record ->> '$.version') IS version
    ),
    PRIMARY KEY (task_id, version),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation),
    FOREIGN KEY (task_id, version, attempt_id, completion_status)
      REFERENCES work_events (task_id, version, attempt_id, status)
  ) STRICT;

  CREATE TABLE outbox_bindings (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    route_id TEXT NOT NULL CHECK (length(route_id) > 0),
    account_id TEXT NOT NULL CHECK (length(account_id) > 0),
    FOREIGN KEY (delivery_id) REFERENCES outbox (id)
  ) STRICT;

  CREATE INDEX outbox_by_task_channel ON outbox (
    task_id, (record ->> '$.destination.sourceInstanceId'), (record ->> '$.destination.externalDestinationId')
  );

  CREATE TRIGGER outbox_preserve_intent BEFORE UPDATE ON outbox
  WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id
    OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.generation IS NOT OLD.generation
    OR NEW.owner_id IS NOT OLD.owner_id OR NEW.profile_id IS NOT OLD.profile_id
    OR NEW.dedupe_key IS NOT OLD.dedupe_key
    OR (NEW.record ->> '$.destination.sourceInstanceId') IS NOT (OLD.record ->> '$.destination.sourceInstanceId')
    OR (NEW.record ->> '$.destination.externalDestinationId') IS NOT (OLD.record ->> '$.destination.externalDestinationId')
    OR (NEW.record ->> '$.payload.text') IS NOT (OLD.record ->> '$.payload.text')
    OR (NEW.record -> '$.payload.artifactIds') IS NOT (OLD.record -> '$.payload.artifactIds')
  BEGIN
    SELECT RAISE(ABORT, 'Outbox intent is immutable');
  END;
`
