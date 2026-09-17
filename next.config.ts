import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Static export: the game is a pure client app — emits plain HTML+assets
  // so the build can be served from GitHub Pages or any static host.
  output: 'export',
};

export default nextConfig;
