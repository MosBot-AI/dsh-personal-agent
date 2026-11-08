/** A pending review can move to one enrolled device without changing the action. */
export const migration015 = `
  CREATE TABLE mobile_approval_reviews (
    request_id TEXT PRIMARY KEY REFERENCES action_approvals(request_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL CHECK (length(device_id) > 0),
    client_id TEXT NOT NULL CHECK (length(client_id) > 0),
    session_id TEXT NOT NULL CHECK (length(session_id) > 0),
    device_verified_at TEXT NOT NULL CHECK (length(device_verified_at) > 0)
  ) STRICT;
  CREATE INDEX mobile_approval_reviews_by_device ON mobile_approval_reviews(device_id, request_id);
`
