import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server (.next/standalone/server.js) with only the traced files, used by the Dockerfile.
  output: "standalone",
  // Server-only SDKs: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@google/genai"],
};

export default nextConfig;
