/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Enable source maps in production to debug client errors
  productionBrowserSourceMaps: true,
  
  experimental: {
    optimizePackageImports: ['lucide-react'],
    // dynamicIO can help avoid unintended prerender in some cases
    // dynamicIO: true,
  },
  
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'microphone=*, camera=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
  
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      }
    }
    return config
  },
  
  // ESLint and TypeScript configurations
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  
  // Image optimization configuration
  images: {
    unoptimized: true,
  },
}

export default nextConfig
