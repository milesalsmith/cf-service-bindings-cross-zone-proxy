// /api/whoami -- diagnostic endpoint that echoes everything observable
// about the inbound request: the parsed URL (from BOTH request.url and
// the x-opennext-initial-url header so the difference is visible),
// every header the callee sees, and the cf object when present.
//
// This exists to make OpenNext's host-rewrite behavior empirically
// observable. See NEXTJS.md ("OpenNext host rewrite") for context.

import { NextRequest } from "next/server";
import { getInboundUrl } from "@/lib/inbound-url";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rawUrl = new URL(request.url);
  const inboundUrl = getInboundUrl(request);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const arrivedVia = request.headers.has("cf-connecting-ip")
    ? "public edge"
    : "service binding";

  return Response.json({
    service: "app-region-1-next",
    runtime: "next.js on opennext/cloudflare",
    arrivedVia,
    // What Next.js's request.url shows directly. Under OpenNext, the
    // host is rewritten to "undefined" before this handler runs.
    rawRequestUrl: {
      href: rawUrl.href,
      hostname: rawUrl.hostname,
      pathname: rawUrl.pathname,
      search: rawUrl.search,
    },
    // What the caller actually wrote. Recovered from the
    // x-opennext-initial-url header when present (binding path), or
    // from request.url when the header is absent (public edge / dev).
    inboundUrl: {
      href: inboundUrl.href,
      hostname: inboundUrl.hostname,
      pathname: inboundUrl.pathname,
      search: inboundUrl.search,
    },
    derivedTenant: inboundUrl.hostname.split(".")[0],
    headerCount: Object.keys(headers).length,
    headers,
    note:
      "Under a Service Binding to an OpenNext Next.js worker, request.url " +
      "is rewritten to 'https://undefined/...'. The original URL is on " +
      "x-opennext-initial-url. Use that header (or the getInboundUrl helper) " +
      "for any host-based logic in Next.js route handlers.",
  });
}
