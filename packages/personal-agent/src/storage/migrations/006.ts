import { migration006Attention } from './006-attention.js'

/** Durable configured-cost reservations and attention decisions. */
export const migration006 = `
  CREATE TABLE budget_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT,
    attempt_id TEXT,
    generation INTEGER,
    task_version INTEGER,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    currency TEXT CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]'),
    pricing_version TEXT NOT NULL,
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    pricing TEXT NOT NULL CHECK (json_type(pricing) IS 'object'),
    ceiling_micros INTEGER CHECK (ceiling_micros BETWEEN 0 AND 9007199254740991),
    actual_micros INTEGER CHECK (actual_micros BETWEEN 0 AND 9007199254740991),
    upper_input_tokens INTEGER NOT NULL CHECK (upper_input_tokens BETWEEN 0 AND 16777216),
    upper_output_tokens INTEGER NOT NULL CHECK (upper_output_tokens BETWEEN 1 AND 16777216),
    unattended INTEGER NOT NULL CHECK (unattended IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed', 'settled', 'uncertain', 'released')),
    usage TEXT CHECK (usage IS NULL OR json_type(usage) IS 'object'),
    CHECK (
      (task_id IS NULL AND attempt_id IS NULL AND generation IS NULL AND task_version IS NULL)
      OR (task_id IS NOT NULL AND attempt_id IS NOT NULL AND generation IS NOT NULL AND task_version IS NOT NULL
        AND generation BETWEEN 0 AND 9007199254740991 AND task_version BETWEEN 0 AND 9007199254740991)
    ),
    CHECK (
      ((pricing ->> '$.kind') IS 'unknown' AND ceiling_micros IS NULL AND actual_micros IS NULL)
      OR ((pricing ->> '$.kind') IS 'known' AND ceiling_micros IS (pricing ->> '$.ceilingMicros')
        AND ceiling_micros IS NOT NULL)
    ),
    CHECK ((status = 'settled') = (usage IS NOT NULL)),
    CHECK (status = 'settled' OR actual_micros IS NULL),
    CHECK (status <> 'settled' OR ceiling_micros IS NULL OR actual_micros IS NOT NULL),
    FOREIGN KEY (task_id, owner_id, profile_id) REFERENCES tasks (id, owner_id, profile_id),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation)
  ) STRICT;

  CREATE INDEX budget_owner_day ON budget_reservations (owner_id, day, currency) WHERE status <> 'released';
  CREATE INDEX budget_task ON budget_reservations (task_id, currency) WHERE task_id IS NOT NULL AND status <> 'released';
  CREATE INDEX budget_open ON budget_reservations (owner_id, currency, status)
    WHERE status IN ('reserved', 'claimed', 'uncertain');

  ${migration006Attention}
`
