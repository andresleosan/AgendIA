// Optional until an explicitly approved operational activation; absent bindings disable work.
interface RecoveryBindings {
  SARIN_RECOVERY_DB?: D1Database;
  SARIN_BACKUPS?: R2Bucket;
  SARIN_BACKUP_ENABLED?: string;
  SARIN_BACKUP_CLEANUP_ENABLED?: string;
  SARIN_BACKUP_HMAC_KEY?: string;
  SARIN_BACKUP_EXPORT_TOKEN?: string;
  SARIN_BACKUP_ACCOUNT_ID?: string;
  SARIN_BACKUP_DATABASE_ID?: string;
  SARIN_BACKUP_DOWNLOAD_ORIGIN?: string;
  SARIN_BACKUP_RECIPIENT?: string;
  SARIN_BACKUP_CONFIG_FILE?: string;
  SARIN_BACKUP_PASSWORD_FILE?: string;
  SARIN_BACKUP_SOURCE_SHA?: string;
}
interface CloudflareBindings extends RecoveryBindings {}
