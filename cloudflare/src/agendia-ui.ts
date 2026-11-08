import { Container, getContainer } from '@cloudflare/containers';
import { handleUiRequest } from './agendia-router.ts';

interface AgendiaUiBindings { AGENDIA_UI: DurableObjectNamespace<AgendiaWeb>; }

export class AgendiaWeb extends Container<AgendiaUiBindings> {
  override defaultPort = 3000;
  override sleepAfter = '2m';
  override enableInternet = false;
  override interceptHttps = false;
  override envVars: Record<string, string> = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '0.0.0.0', PORT: '3000' };

  override onError(_error: unknown): void {
    throw new Error('La interfaz de AgendIA no está disponible.');
  }
}

export default {
  fetch(request: Request, env: AgendiaUiBindings): Promise<Response> {
    return handleUiRequest(request, name => getContainer(env.AGENDIA_UI, name));
  },
} satisfies ExportedHandler<AgendiaUiBindings>;
