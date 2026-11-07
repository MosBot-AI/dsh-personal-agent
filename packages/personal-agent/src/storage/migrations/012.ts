/** Project-scoped skill revisions, evaluation and owner feedback. */
export const migration012 = `
  CREATE TABLE reviewed_skills (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects (id),
    latest INTEGER NOT NULL CHECK (latest > 0),
    active INTEGER CHECK (active > 0 AND active <= latest),
    selection INTEGER NOT NULL DEFAULT 0 CHECK (selection >= 0)
  ) STRICT;
  CREATE INDEX reviewed_skills_project ON reviewed_skills (owner_id, profile_id, project_id);

  CREATE TABLE skill_revisions (
    skill_id TEXT NOT NULL REFERENCES reviewed_skills (id),
    version INTEGER NOT NULL CHECK (version > 0),
    digest TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    spec TEXT NOT NULL CHECK (json_type(spec) IS 'object'),
    evaluation TEXT CHECK (json_type(evaluation) IS 'array' OR evaluation IS NULL),
    approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
    rollbacks INTEGER NOT NULL DEFAULT 0 CHECK (rollbacks >= 0),
    PRIMARY KEY (skill_id, version)
  ) STRICT;

  CREATE TABLE skill_uses (
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    id TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    feedback TEXT CHECK (feedback IN ('accepted', 'correction')),
    PRIMARY KEY (skill_id, id),
    FOREIGN KEY (skill_id, version) REFERENCES skill_revisions (skill_id, version)
  ) STRICT;
  CREATE INDEX skill_uses_version ON skill_uses (skill_id, version, feedback);
`
