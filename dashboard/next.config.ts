import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/proxy/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://127.0.0.1:3456"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
