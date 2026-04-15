import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@kubernetes/client-node'],
  // Pin webpack module resolution to this project's node_modules so it
  // doesn't walk up to a parent package-lock.json.
  webpack: (config) => {
    config.resolve.modules = [
      path.resolve(__dirname, 'node_modules'),
      'node_modules',
    ];
    return config;
  },
  turbopack: {
    root: __dirname,
    resolveAlias: {
      tailwindcss: path.resolve(__dirname, 'node_modules/tailwindcss'),
    },
  },
};

export default nextConfig;
