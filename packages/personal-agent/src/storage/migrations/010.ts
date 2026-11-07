/** Goal plan history, scoped prerequisite edges and cursor-bound Worker drafts. */
export const migration010 = `
  CREATE TABLE project_plan_revisions (
    project_id TEXT NOT NULL REFERENCES projects (id),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    command_id TEXT,
    fingerprint TEXT,
    record TEXT NOT NULL CHECK (json_type(record) IS 'object' AND (record ->> '$.project.id') IS project_id
      AND (record ->> '$.project.planRevision') IS revision),
    PRIMARY KEY (project_id, revision),
    UNIQUE (project_id, command_id)
  ) STRICT;

  CREATE TABLE task_prerequisites (
    task_id TEXT NOT NULL REFERENCES tasks (id),
    prerequisite_id TEXT NOT NULL REFERENCES tasks (id),
    CHECK (task_id <> prerequisite_id),
    PRIMARY KEY (task_id, prerequisite_id)
  ) STRICT;
  CREATE INDEX task_prerequisite_reverse ON task_prerequisites (prerequisite_id, task_id);

  CREATE TABLE task_plan_proposals (
    task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks (id),
    attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    cursor TEXT NOT NULL,
    record TEXT NOT NULL CHECK (json_type(record) IS 'array'),
    FOREIGN KEY (task_id, attempt_id, generation) REFERENCES attempts (task_id, id, generation)
  ) STRICT;
`
