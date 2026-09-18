/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,

  // Both ship TypeScript source, not build artifacts — see the root app's
  // next.config.mjs for why.
  transpilePackages: ['@historical-map/domain', '@historical-map/api-client'],

  experimental: {
    optimizePackageImports: ['ol'],
  },
}

export default nextConfig
