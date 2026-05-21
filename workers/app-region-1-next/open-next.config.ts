import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal config: no R2 cache, no image optimization. Sufficient for a
// reference architecture that only exercises route handlers; production
// apps would add r2IncrementalCache. See:
// https://opennext.js.org/cloudflare/caching
export default defineCloudflareConfig();
