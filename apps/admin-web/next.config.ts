import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  experimental: {
    // Enable React 19 server actions
    serverActions: { allowedOrigins: ['localhost:3120'] },
  },
  env: {
    IDENTITY_URL:  process.env['IDENTITY_URL']  ?? 'http://localhost:3110',
    PIPELINE_URL:  process.env['PIPELINE_URL']  ?? 'http://localhost:3100/api/v1',
  },
};

export default config;
