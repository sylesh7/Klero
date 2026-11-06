import path from 'node:path';
import type { NextConfig } from 'next';

// The frontend is a standalone project: everything it needs lives inside this folder.
const root = path.join(__dirname);

const nextConfig: NextConfig = {
  // the dev-mode badge would sit on top of the page's own fixed elements
  devIndicators: false,
  outputFileTracingRoot: root,
  turbopack: { root },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
