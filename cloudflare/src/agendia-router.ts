import { isUiRequest, PUBLIC_ORIGIN, rejected, serviceResponse } from '../../pages-gateway/worker.mjs';

export async function handleUiRequest(request: Request, get: (name: string) => { fetch(request: Request): Promise<Response> }): Promise<Response> {
  if (new URL(request.url).origin !== PUBLIC_ORIGIN || !isUiRequest(request)) return rejected(request);
  return serviceResponse(request, get('agendia-ui'));
}
