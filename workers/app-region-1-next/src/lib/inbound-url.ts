// Helper for getting the *original* request URL inside a Next.js route
// handler running on @opennextjs/cloudflare.
//
// Why this exists, in one paragraph:
// When a Worker calls a plain Worker through a Service Binding, the
// callee sees `request.url` set to whatever URL the caller passed to
// env.MY_BINDING.fetch(...). When that callee is instead a Next.js
// application deployed via OpenNext, OpenNext rewrites the inbound
// request before handing it to Next.js: `request.url` becomes
// `https://undefined/...` and `request.headers.get("host")` becomes
// "undefined". The original URL is preserved on the
// `x-opennext-initial-url` header. This was discovered by an end-to-end
// test against deployed Workers (see NEXTJS.md, "OpenNext host rewrite").
//
// As far as we can tell from observed behavior:
// - Path and query string survive untouched on `request.url`.
// - Host portion is replaced with the literal string "undefined".
// - Original URL (including the caller-chosen host) is on
//   `x-opennext-initial-url`.
//
// This helper returns the inbound URL the caller actually wrote. Use it
// any time you would have done `new URL(request.url)` in a plain Worker
// and you need host-based logic (tenant routing, region selection,
// etc.) to keep working under OpenNext.
//
// For non-host-based logic (just pathname/query), `new URL(request.url)`
// remains fine; OpenNext does not touch those parts.

export function getInboundUrl(request: Request): URL {
  const opennextInitialUrl = request.headers.get("x-opennext-initial-url");
  if (opennextInitialUrl) {
    return new URL(opennextInitialUrl);
  }
  // Local dev with `next dev` and direct public hits without OpenNext
  // both fall through to the raw URL.
  return new URL(request.url);
}
