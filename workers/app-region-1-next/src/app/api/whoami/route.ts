// /api/whoami -- diagnostic endpoint that echoes everything observable
// about the inbound request: parsed URL components, every header the
// callee sees, and the cf object when present.
//
// This exists specifically to answer Andrew's open question from the
// meeting notes:
//   "Can the host name still be sent and received by the target worker
//    when using a service binding?"
//
// The proxy will call:
//   env.APP_REGION_1_NEXT.fetch("https://${tenant}.internal/api/whoami")
// and the response will show:
//   - hostname:       ${tenant}.internal       (the binding-supplied host)
//   - headers.host:   <whatever Next/OpenNext surfaces>
//   - arrivedVia:     "service binding"        (no cf-connecting-ip)
//
// Read this against the same call going through proxy-production-bad,
// where hostname will be the workers.dev URL and cf-connecting-ip will
// be set, to see the difference between the two transports concretely.

import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
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
    parsedUrl: {
      href: url.href,
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    },
    derivedTenant: url.hostname.split(".")[0],
    headerCount: Object.keys(headers).length,
    headers,
    note:
      "If arrivedVia is 'service binding', parsedUrl.hostname is whatever the " +
      "caller wrote (e.g. 'tenant-b.internal'), proving the host portion is " +
      "delivered to the Next.js callee intact.",
  });
}
