-- Independent additive indexes; 0012 and 0013 belong to the preceding R1 contracts.
CREATE INDEX IF NOT EXISTS app_response_quota_pending ON app_documents (
  parent, json_extract(data, '$.status'), json_extract(data, '$.nextAttemptAt'), document_id, path
);
CREATE INDEX IF NOT EXISTS app_response_quota_discovery ON app_documents (
  parent, json_extract(data, '$.status'), document_id, path
);
