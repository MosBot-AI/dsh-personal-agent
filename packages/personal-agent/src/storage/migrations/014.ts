/** One-use mobile enrollment and revocable per-device credentials. */
export const migration014 = `
  CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    label TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
    secret_hash TEXT UNIQUE,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    enrolled_at TEXT,
    CHECK (expires_at > issued_at),
    CHECK ((state = 'revoked') = (secret_hash IS NULL)),
    CHECK (state <> 'pending' OR enrolled_at IS NULL),
    CHECK (state <> 'active' OR enrolled_at IS NOT NULL)
  ) STRICT;
  CREATE INDEX mobile_devices_scope ON mobile_devices(owner_id, profile_id, state, expires_at);
`
