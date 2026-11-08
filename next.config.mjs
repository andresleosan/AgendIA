/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  agentRules: false,
  output: 'standalone',
  poweredByHeader: false,
  images: { localPatterns: [{ pathname: '/brand/**' }] },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    ] }];
  },
};

export default nextConfig;
