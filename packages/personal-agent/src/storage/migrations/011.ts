/** Goal-scoped initiative rules and durable evaluation evidence. */
export const migration011 = `
  CREATE TABLE proactive_rules (
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record) IS 'object' AND (record ->> '$.id') IS id),
    PRIMARY KEY (owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, scope_key)
  ) STRICT;

  CREATE TABLE proactive_candidates (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES source_events (id),
    spec TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    admitted_at TEXT,
    record TEXT NOT NULL CHECK (json_type(record) IS 'object' AND (record ->> '$.id') IS id),
    FOREIGN KEY (owner_id, profile_id, rule_id) REFERENCES proactive_rules (owner_id, profile_id, id),
    UNIQUE (owner_id, profile_id, rule_id, event_id)
  ) STRICT;
  CREATE INDEX proactive_candidates_admission ON proactive_candidates (owner_id, profile_id, rule_id, spec, admitted_at);

  CREATE TABLE attention_local_notices (
    decision_id TEXT PRIMARY KEY NOT NULL REFERENCES attention_decisions (id),
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX attention_local_notice_usage ON attention_local_notices (owner_id, created_at);
`
