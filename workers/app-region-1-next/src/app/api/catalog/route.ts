// /api/catalog -- host-based tenant routing mirror of app-region-1's
// /api/catalog route. The proxy calls
//   env.APP_REGION_1_NEXT.fetch("https://${tenant}.internal/api/catalog?size=KB")
// and this handler:
//   - parses the tenant from request.url's hostname,
//   - returns a controllable-size JSON payload,
//   - reports whether the request arrived via the public edge or a
//     Service Binding (via the cf-connecting-ip header heuristic).
//
// This is the empirical answer to Andrew's first action item:
// "Is it possible to set up a service binding target/producer within a
// Next.js application for the proxy worker to connect to?"
// Yes -- a Next.js route handler running on OpenNext receives the
// binding-supplied request like any other, including the caller's host.

import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tenant = url.hostname.split(".")[0];
  const arrivedVia = request.headers.has("cf-connecting-ip")
    ? "public edge"
    : "service binding";

  const sizeKb = clampSize(url.searchParams.get("size"));

  return Response.json({
    service: "app-region-1-next",
    runtime: "next.js on opennext/cloudflare",
    tenant,
    path: url.pathname,
    arrivedVia,
    payloadSizeKb: sizeKb,
    data: "x".repeat(sizeKb * 1024),
  });
}

function clampSize(raw: string | null): number {
  const n = Number(raw ?? 64);
  if (!Number.isFinite(n)) return 64;
  return Math.min(Math.max(n, 0), 1024);
}
