/** Durable input intents and one recovery admission gate per work database. */
export const migration004 = `
  CREATE TABLE runtime_recovery (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('normal', 'reconciling', 'restore'))
  ) STRICT;

  INSERT INTO runtime_recovery (id, mode) VALUES (1, 'normal');

  CREATE TABLE worker_inputs (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    cursor TEXT NOT NULL CHECK (length(cursor) BETWEEN 1 AND 256),
    session_id TEXT NOT NULL CHECK (length(session_id) > 0),
    message_id TEXT NOT NULL CHECK (length(message_id) > 0),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 131072),
    kind TEXT NOT NULL CHECK (kind IN ('followup', 'steer')),
    status TEXT NOT NULL CHECK (
      status IN ('intent', 'flushed', 'pending', 'admitted', 'cancelled', 'not_delivered', 'unknown')
    ),
    flushed_at TEXT CHECK (status <> 'flushed' OR flushed_at IS NOT NULL),
    observed_at TEXT,
    PRIMARY KEY (task_id, attempt_id, generation, cursor),
    UNIQUE (session_id, message_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation)
  ) STRICT;
`
