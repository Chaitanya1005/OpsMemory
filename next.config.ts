import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only SDKs: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@google/genai"],
};

export default nextConfig;
