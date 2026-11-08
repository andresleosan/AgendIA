import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AgendIA', short_name: 'AgendIA', lang: 'es',
    description: 'Tus clientes agendan, la IA trabaja. Asistente virtual: Sarin Bot.',
    start_url: '/dashboard', scope: '/', display: 'standalone',
    background_color: '#f7f9ff', theme_color: '#f7f9ff',
    icons: [
      { src: '/brand/agendia-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/agendia-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
