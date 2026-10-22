import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ticketapp/shared"],
  experimental: {
    // Room for a student roster CSV (MAX_ROSTER_BYTES) and the form around it.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
