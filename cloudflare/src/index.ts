import { cleanupAdminPaymentRetention } from './admin-payment-retention.ts';
import { scheduleRecoveryBackup, handleRecoveryOutbound, sourceObjectsPinned } from './recovery-backup.ts';
import { recoverWorkerResponseQuota } from './response-quota-recovery.ts';
import { cleanupPlatformSupportRetention } from './platform-support-retention.ts';
import { hasPotentialPlatformWork } from './platform-whatsapp-wake.ts';
import { handlePlatformAudioOutbound } from './platform-whatsapp-audio.ts';
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { handleIdentityOutbound, handlePublicIdentityRequest } from './identity.ts';
import { handleDataOutbound } from './data.ts';
import { cleanupPlatformWhatsAppRetention } from './platform-whatsapp-retention.ts';
import { backgroundWorkEnabled, forwardToSingleton, runtimeEnvironment, wakeBackgroundSingleton, SINGLETON_NAME } from './router.ts';

export { SarinIdentity } from './identity.ts';
export { ContainerProxy };

/** The DO stores SDK lifecycle metadata only; application bodies never enter DO storage. */
export class SarinApp extends Container<CloudflareBindings> {
  override defaultPort = 3000;
  override sleepAfter = '2m';
  // Firebase Admin uses native TLS/gRPC. Avoid HTTPS interception and its CA/protocol changes.
  override enableInternet = true;
  override interceptHttps = false;

  constructor(ctx: ConstructorParameters<typeof Container<CloudflareBindings>>[0], env: CloudflareBindings) {
    super(ctx, env);
    this.envVars = runtimeEnvironment({ ...env });
  }

  override onError(_error: unknown): void {
    // No error payload, token, URL or request body is logged from this hook.
    throw new Error('El proceso de la aplicación no está disponible.');
  }

  override async onActivityExpired(): Promise<void> {
    // WhatsApp polling and retention run in Node after HTTP responses finish.
    // Keep that process alive only when one of those explicit flags is enabled.
    if (backgroundWorkEnabled(this.envVars ?? {})) {
      this.renewActivityTimeout();
      return;
    }
    if (this.env.SARIN_RECOVERY_DB && await sourceObjectsPinned(this.env)) {
      this.renewActivityTimeout();
      return;
    }
    if (this.ctx.container?.running) await this.stop();
  }
}

// Invoke the SDK's inherited setter to populate ContainerProxy's dispatch registry.
// A subclass static field would shadow that setter in the pinned SDK 0.3.7.
SarinApp.outboundByHost = { 'sarin-google.internal': handleIdentityOutbound, 'sarin-data.internal': handleDataOutbound, 'sarin-audio.internal': handlePlatformAudioOutbound, 'sarin-backup.internal': handleRecoveryOutbound };

export default {
  async fetch(request: Request, env: CloudflareBindings): Promise<Response> {
    // Google must discover the signing keys even before application runtime is configured.
    const identity = await handlePublicIdentityRequest(request, env);
    if (identity) return identity;
    return forwardToSingleton(request, (name) => getContainer(env.SARIN_APP, name), { ...env });
  },
  async scheduled(_controller: ScheduledController, env: CloudflareBindings): Promise<void> {
    const flags: Record<string, unknown> = { ...env };
    try { await scheduleRecoveryBackup(env); } catch { console.error({ event: 'recovery_backup_failed' }); }
    if (flags.SARIN_MAINTENANCE !== 'true') {
      try {
        const quota = await recoverWorkerResponseQuota(env);
        if (quota.visited) console.info({ event: 'response_quota_recovery', ...quota });
      } catch { console.error({ event: 'response_quota_recovery_failed' }); }
      const result = await cleanupAdminPaymentRetention(env);
      if (result.morePending || result.clearedBodies || result.deletedMetadata) console.info({ event: 'admin_payment_retention', ...result });
      if (flags.PLATFORM_WHATSAPP_RETENTION_ENABLED !== 'true') {
        const support = await cleanupPlatformSupportRetention(env);
        if (support.morePending || support.clearedBodies || support.deletedMetadata) console.info({ event: 'platform_support_retention', ...support });
      }
    }
    if (flags.PLATFORM_WHATSAPP_RETENTION_ENABLED === 'true' && flags.SARIN_MAINTENANCE !== 'true') {
      const result = await cleanupPlatformWhatsAppRetention(env);
      console.info({ event: 'platform_whatsapp_retention', ...result });
    }
    if (backgroundWorkEnabled(flags)) await wakeBackgroundSingleton(flags, (name) => getContainer(env.SARIN_APP, name));
    else if (await hasPotentialPlatformWork(env)) await getContainer(env.SARIN_APP, SINGLETON_NAME).startAndWaitForPorts();
  },
} satisfies ExportedHandler<CloudflareBindings>;
