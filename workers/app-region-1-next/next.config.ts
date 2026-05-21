import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // No special config required for this demo. Server-side route handlers
  // only; no static export, no edge runtime.
};

// Required so `next dev` can resolve Cloudflare bindings during local
// development. See:
// https://opennext.js.org/cloudflare/get-started#12-develop-locally
initOpenNextCloudflareForDev();

export default nextConfig;
