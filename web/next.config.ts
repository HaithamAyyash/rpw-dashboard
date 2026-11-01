import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native module; must be loaded by Node, not bundled.
  serverExternalPackages: ["@node-rs/argon2"],
};

export default nextConfig;
