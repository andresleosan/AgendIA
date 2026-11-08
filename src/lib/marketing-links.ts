const PUBLIC_APP_ORIGIN = "https://agendia-app.pages.dev";

export function publicApplicationOrigin(value?: string): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("SARIN_PUBLIC_APP_URL debe ser el origen HTTPS público aprobado.");
  }
  if (url.origin !== PUBLIC_APP_ORIGIN || url.username || url.password || url.pathname !== "/" || /[?#]/.test(value)) {
    throw new Error("SARIN_PUBLIC_APP_URL debe ser https://agendia-app.pages.dev, sin ruta, credenciales ni parámetros.");
  }
  return url.origin;
}
