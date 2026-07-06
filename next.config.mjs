/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Allow larger request bodies for line-sheet uploads handled by route handlers.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
