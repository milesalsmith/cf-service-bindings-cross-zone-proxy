#!/usr/bin/env node
/**
 * Toggle `workers_dev` in workers/app-region-1/wrangler.toml.
 *
 *   node scripts/toggle-private.mjs on      -> workers_dev = false  (private)
 *   node scripts/toggle-private.mjs off     -> workers_dev = true   (public on workers.dev)
 *   node scripts/toggle-private.mjs status  -> print current value
 *
 * Used by `npm run private:on` / `npm run private:off`, which also redeploy
 * app-region-1 so the change takes effect.
 *
 * Why this script exists: the strongest demonstration of the Service Binding
 * argument is to take the callee off the public internet entirely. With
 * `workers_dev = false`:
 *   - proxy-production-good keeps working (the binding does not need a public URL).
 *   - proxy-production-bad stops working (no workers.dev URL to fetch).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../workers/app-region-1/wrangler.toml");

const mode = (process.argv[2] ?? "").toLowerCase();
if (!["on", "off", "status"].includes(mode)) {
  console.error("Usage: node scripts/toggle-private.mjs <on|off|status>");
  process.exit(2);
}

const original = readFileSync(target, "utf8");
const match = original.match(/^(\s*workers_dev\s*=\s*)(true|false)\s*$/m);
if (!match) {
  console.error(
    `Could not find a 'workers_dev = true|false' line in ${target}.\n` +
      "Add one (e.g. 'workers_dev = true') and re-run.",
  );
  process.exit(1);
}

const currentlyPublic = match[2] === "true";
const currentlyPrivate = !currentlyPublic;

if (mode === "status") {
  console.log(
    `app-region-1 workers_dev = ${match[2]}  (${currentlyPublic ? "PUBLIC on workers.dev" : "PRIVATE, binding-only"})`,
  );
  process.exit(0);
}

const want = mode === "on" ? "false" : "true"; // "on" = privacy on = workers_dev false
const already =
  (mode === "on" && currentlyPrivate) || (mode === "off" && currentlyPublic);

if (already) {
  console.log(
    `No change: app-region-1 already ${mode === "on" ? "PRIVATE" : "PUBLIC"} (workers_dev = ${match[2]}).`,
  );
  process.exit(0);
}

// Preserve the file's trailing newline (if any) since some replacement
// paths can strip it when match[0] sits at end-of-file.
const updated = original.replace(match[0], `${match[1]}${want}`);
const finalText = original.endsWith("\n") && !updated.endsWith("\n") ? updated + "\n" : updated;
writeFileSync(target, finalText);
console.log(
  `app-region-1 workers_dev: ${match[2]} -> ${want}  ` +
    `(now ${mode === "on" ? "PRIVATE, binding-only" : "PUBLIC on workers.dev"}).`,
);
