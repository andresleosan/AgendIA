-- Apply only to the separate recovery control database, never SARIN_DB.
-- Provision the start marker only after an approved drained-writer cutover; no invented history.
CREATE TABLE recovery_witness_start (
  id INTEGER PRIMARY KEY CHECK(id=1), resource_id TEXT NOT NULL,
  start_revision INTEGER NOT NULL CHECK(start_revision>=0), started_at INTEGER NOT NULL
);
CREATE TRIGGER recovery_start_update BEFORE UPDATE ON recovery_witness_start
BEGIN SELECT RAISE(ABORT,'Immutable witness start'); END;
CREATE TRIGGER recovery_start_delete BEFORE DELETE ON recovery_witness_start
BEGIN SELECT RAISE(ABORT,'Immutable witness start'); END;
CREATE TABLE recovery_invalidations (
  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, covered_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  status TEXT NOT NULL CHECK(status IN ('pending','complete')), revision INTEGER,
  CHECK((status='pending' AND revision IS NULL) OR (status='complete' AND revision=covered_revision+1))
);
CREATE INDEX recovery_witness_revision ON recovery_invalidations(revision);
CREATE TRIGGER recovery_witness_update BEFORE UPDATE ON recovery_invalidations
WHEN NEW.request_id!=OLD.request_id OR NEW.fingerprint!=OLD.fingerprint OR NEW.covered_revision!=OLD.covered_revision
  OR NEW.created_at!=OLD.created_at OR NEW.scopes!=OLD.scopes OR (OLD.status='complete' AND (NEW.status!='complete' OR NEW.revision!=OLD.revision))
BEGIN SELECT RAISE(ABORT,'Immutable witness intent'); END;
-- No TTL: all intents outlive every retained snapshot, including pending and false positives.
CREATE TRIGGER recovery_witness_delete BEFORE DELETE ON recovery_invalidations
BEGIN SELECT RAISE(ABORT,'Retained recovery witness'); END;
CREATE TABLE recovery_admission (resource_id TEXT PRIMARY KEY, approval TEXT NOT NULL CHECK(json_valid(approval)));
CREATE TABLE backup_runs (
  fence INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
  schedule_day TEXT NOT NULL,
  prechange INTEGER NOT NULL DEFAULT 0 CHECK(prechange IN (0,1)),
  phase TEXT NOT NULL CHECK(phase IN ('preparing','copying','verifying','sealed','failed')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  failure_code TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  export_bookmark TEXT,
  export_url TEXT,
  export_started_at INTEGER,
  export_completed_at INTEGER,
  artifacts_cleaned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(schedule_day,attempt)
);
CREATE UNIQUE INDEX backup_single_active ON backup_runs(active) WHERE active=1;
CREATE TABLE backup_objects (
  object_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  refcount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE backup_run_objects (
  backup_id TEXT NOT NULL REFERENCES backup_runs(backup_id),
  object_id TEXT NOT NULL REFERENCES backup_objects(object_id),
  PRIMARY KEY(backup_id,object_id)
);
CREATE TABLE backup_catalog (
  backup_id TEXT PRIMARY KEY REFERENCES backup_runs(backup_id),
  sealed_at INTEGER NOT NULL,
  recoverable_at INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  snapshot_times TEXT NOT NULL,
  prechange INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE backup_restore_evidence (
  backup_id TEXT NOT NULL REFERENCES backup_catalog(backup_id) ON DELETE CASCADE,
  artifact_sha256 TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(backup_id,artifact_sha256)
);
CREATE TRIGGER backup_restore_evidence_immutable BEFORE UPDATE ON backup_restore_evidence
BEGIN SELECT RAISE(ABORT,'Immutable recovery evidence'); END;
CREATE TRIGGER backup_restore_evidence_retained BEFORE DELETE ON backup_restore_evidence
WHEN EXISTS(SELECT 1 FROM backup_catalog WHERE backup_id=OLD.backup_id)
BEGIN SELECT RAISE(ABORT,'Retained recovery evidence'); END;
