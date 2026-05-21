# Next.js + OpenNext companion (this branch)

This branch adds a Next.js application worker (`app-region-1-next`)
deployed via [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare)
that plays the same role as the plain Worker `app-region-1`, so we can
answer Andrew's three open questions from the meeting notes
empirically rather than by inference.

## What's added on this branch

| Path | Purpose |
| --- | --- |
| `workers/app-region-1-next/` | Next.js app on OpenNext. Same role as `app-region-1`. |
| `workers/app-region-1-next/src/app/api/catalog/route.ts` | Host-based tenant routing, controllable-size payload. Mirror of `app-region-1`'s `/api/catalog`. |
| `workers/app-region-1-next/src/app/api/whoami/route.ts` | Echoes the parsed URL, all inbound headers, and the derived tenant. The empirical answer to the host-forwarding question. |
| `workers/app-region-1-next/src/api-client.ts` | The same Vercel-portable adapter as the plain Worker. Imported by route handlers; consumes `env` via `getCloudflareContext()` on Workers, or `process.env.API_BASE_URL` on Vercel. |
| `workers/proxy-production-good/wrangler.toml` | Adds a second `[[services]]` block: `binding = "APP_REGION_1_NEXT"`. |
| `workers/proxy-production-bad/wrangler.toml` | Adds a second `var`: `APP_WORKER_NEXT_URL`. |
| Both proxies' `src/index.ts` | Accept `?backend=plain\|next` and route to the corresponding callee. |
| `workers/demo-router/src/index.ts` | Adds `/good-next` and `/bad-next` shortcuts; the comparison summary includes `backend` and `backendService`. |

## Topology on this branch

```
                          demo-router
                           /        \
              [Service Binding]   [Service Binding]
                  /                       \
       proxy-production-bad           proxy-production-good
         fetch(workers.dev URL)        env.APP_REGION_1.fetch(...)
                                       env.APP_REGION_1_NEXT.fetch(...)
            ?backend=plain | next    ?backend=plain | next
                  \                       /
                   v                     v
        app-region-1 (plain Worker)   app-region-1-next (Next.js / OpenNext)
        host-based tenant routing     host-based tenant routing in
        in a Worker handler           a Next.js route handler
```

`proxy-production-good` now holds **two** Service Bindings, one per
backend. The proxy code picks between them based on the `?backend` query
param; the rest of the call is identical. This isolates "binding to a
plain Worker" vs. "binding to a Next.js / OpenNext Worker" as the only
variable between two otherwise-identical calls.

## Answering the meeting's open questions

The action items recorded in the meeting notes were:

> 1. Is it possible to set up a service binding **target/producer** within
>    a Next.js application for the proxy worker to connect to?
> 2. Is it possible to set up a service binding **consumer** within a
>    Next.js application to connect to the API worker?
> 3. Can the **host name** still be sent and received by the target
>    worker when using a service binding?

### Q1: Next.js as a Service Binding target (producer)

**Yes.** The Next.js app is deployed by `@opennextjs/cloudflare`, which
produces a standard Workers bundle at `.open-next/worker.js`. From the
perspective of the calling Worker, this bundle is just another Worker
in the account, addressable by its `name` (`app-region-1-next`).

The binding lives on the **caller** (the proxy), not the callee:

```jsonc
// workers/proxy-production-good/wrangler.toml
[[services]]
binding = "APP_REGION_1_NEXT"
service = "app-region-1-next"
```

No change is required on the Next.js side beyond deploying it. The
default Next.js route-handler entry point catches the binding-supplied
request like any other inbound HTTPS request.

Evidence: `workers/app-region-1-next/src/app/api/catalog/route.ts`
returns `arrivedVia: "service binding"` when called through the
binding (no `cf-connecting-ip` header), and `"public edge"` when hit
directly on `workers.dev`.

### Q2: Next.js as a Service Binding consumer

**Yes.** In any server-side Next.js code (route handler, server
component, server action, middleware running on the Node runtime),
bindings are reached via `getCloudflareContext().env.MY_BINDING`. The
adapter `workers/app-region-1-next/src/api-client.ts` is the
production-shaped example: it accepts an `env` of shape
`{ API?: Fetcher; API_BASE_URL?: string }` and prefers the Service
Binding when present. The consuming route handler imports
`getApiClient`, passes `env`, and calls
`getApiClient(env).get("/some/path")`.

The same source file works unchanged on Vercel because the adapter
branches on which env property is set.

### Q3: Does the host name survive the binding?

**Yes -- but with a real OpenNext-specific caveat that we discovered
only by running this end-to-end.** This is the most important finding
from the live test.

#### The short version

- A plain Worker callee sees `request.url` set to whatever the caller
  passed to `env.MY_BINDING.fetch(...)`, including the host portion.
  `new URL(request.url).hostname` returns the caller's host. Confirmed
  on `app-region-1`.
- A Next.js callee on OpenNext sees `request.url === "https://undefined/..."`
  and `request.headers.get("host") === "undefined"`. The Next.js
  request object does not get the caller's host directly.
- The original URL the caller wrote IS preserved, on an
  `x-opennext-initial-url` header set by OpenNext. Pathname and query
  string survive on `request.url` untouched.

Use the helper `src/lib/inbound-url.ts` (or read the
`x-opennext-initial-url` header yourself) any time you need the
caller-supplied host inside a Next.js route handler on OpenNext.
`request.url` alone is not enough.

#### What we actually observed

`/api/whoami` returns both views side-by-side so the difference is
self-documenting. Sample response over a Service Binding, with the
caller passing `https://tenant-c.internal/api/whoami`:

```jsonc
{
  "service": "app-region-1-next",
  "runtime": "next.js on opennext/cloudflare",
  "arrivedVia": "service binding",
  "rawRequestUrl": {
    "href": "https://undefined/api/whoami",   // <- Next.js sees this
    "hostname": "undefined",
    "pathname": "/api/whoami",
    "search": ""
  },
  "inboundUrl": {
    "href": "https://tenant-c.internal/api/whoami",  // <- from getInboundUrl()
    "hostname": "tenant-c.internal",
    "pathname": "/api/whoami",
    "search": ""
  },
  "derivedTenant": "tenant-c",
  "headers": {
    "host": "undefined",
    "x-forwarded-host": "undefined",
    "x-opennext-initial-url": "https://tenant-c.internal/api/whoami",
    // ... other OpenNext bookkeeping headers ...
  }
}
```

`rawRequestUrl.hostname === "undefined"`. `inboundUrl.hostname === "tenant-c.internal"`.

#### How `getInboundUrl()` works

```ts
// workers/app-region-1-next/src/lib/inbound-url.ts
export function getInboundUrl(request: Request): URL {
  const opennextInitialUrl = request.headers.get("x-opennext-initial-url");
  if (opennextInitialUrl) {
    return new URL(opennextInitialUrl);
  }
  return new URL(request.url);
}
```

The route handlers use it like this:

```ts
// workers/app-region-1-next/src/app/api/catalog/route.ts
const url = getInboundUrl(request);
const tenant = url.hostname.split(".")[0];
```

This is the only line of code in this branch that has to differ from
the equivalent plain Worker. Everything else -- the proxy's
wrangler.toml, the `[[services]]` block, the path/query forwarding,
the api-client adapter -- is identical.

#### Practical consequence for the customer migration

Any Next.js application that does host-based tenant resolution from
`request.url`, `headers.host`, or `headers["x-forwarded-host"]` will
silently produce the wrong tenant the moment it's called over a Service
Binding under OpenNext. There is no error; you get whatever
`"undefined".split(".")[0]` produces.

Migration checklist for a real customer:

1. Grep the Next.js app for `request.url`, `headers.host`,
   `headers["x-forwarded-host"]`, `headers.get("host")`,
   `getRequestHeaders` host reads, and anywhere `hostname` is derived
   from the incoming request.
2. At each of those sites, prefer the
   `x-opennext-initial-url` header when present, falling back to
   `request.url` for the public-edge / `next dev` case.
3. A single small helper (`getInboundUrl(request)`) keeps the change
   surface small and centralizes the OpenNext-specific behavior.

#### Was this documented anywhere?

Not that we found in the [OpenNext Cloudflare get-started
guide](https://opennext.js.org/cloudflare/get-started). The
`x-opennext-initial-url` header is observable by inspection, and the
header naming makes the intent reasonably clear, but the behavior is
not called out in the docs we read while building this branch. This
branch's `/api/whoami` route is the recipe for verifying it on any
account.

#### Anti-pattern proxy + Next.js callee: error 1042

`/bad-next` (the same-account public fetch from `proxy-production-bad`
to `app-region-1-next.workers.dev`) returns Cloudflare **error 1042**
("same-account public-hostname loop refused"). This is the same
behavior the meeting notes describe when the customer attempted to
move the workers to the same zone. It is not specific to the Next.js
worker; the plain `app-region-1` exhibits the same behavior on
`/bad`. The binding path bypasses 1042 entirely because the call never
leaves the runtime.

## What was validated end-to-end against a live Cloudflare account

After the initial pre-push checks (`next build`, `opennextjs-cloudflare
build`, `wrangler deploy --dry-run`), all five Workers were deployed to
a real Cloudflare account and exercised via `curl`. Findings, all
observed in the response bodies:

| Check | Result |
|---|---|
| `/?backend=plain` -- plain Worker callee via binding | `goodDataTransferBilledBytes: 0`, `tenantSeenByGood: "tenant-b"`, `arrivedViaGood: "service binding"` |
| `/?backend=next` -- Next.js callee via binding | Same binding mechanics. **Initially returned `tenant: "undefined"`**; fixed via `getInboundUrl()` helper (see Q3). |
| `/?size=256` -- 256 KB payload through binding | `upstreamBytes: 262273`, `dataTransferBilledBytes: 0` |
| `/good-next?path=/api/whoami` | Confirmed `request.url` host rewrite to `"undefined"`; `x-opennext-initial-url` header preserves the real URL. |
| `/bad-next?path=/api/whoami` | Cloudflare error 1042 (expected -- same-account public-hostname loop). |
| `npm run private:on` -> direct hit to callee | HTTP 404 (worker is off the public internet). |
| `npm run private:on` -> via `proxy-production-good` | HTTP 200, tenant correctly resolved, zero data transfer billed. The binding does not need the callee to be public. |
| `npm run private:on` -> via `proxy-production-bad` | Error 1042 / 16-byte error page. The anti-pattern stops working. |

The "Initially returned `tenant: 'undefined'`" row is the discovery the
in-session live test was worth doing for. The published code already
applies the fix.

#### Reproducing locally

Local-only wrangler overrides go in `wrangler.local.toml` or
`wrangler.local.jsonc` next to each existing wrangler config file.
These files are in `.gitignore` and never reach the public repo. They
hold the real KV namespace id, your `workers.dev` subdomain, and the
account id you want to deploy under. Deploy with:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npx wrangler deploy --config workers/<worker-name>/wrangler.local.toml
```

Deploy order matters and is encoded in `deploy:all`:

1. `app-region-1`
2. `app-region-1-next`  (this branch)
3. `proxy-production-bad`, `proxy-production-good`
4. `demo-router`

## A configuration gotcha worth knowing

`@cloudflare/workers-types` is a `devDependency` of the Next.js worker
even though Next.js apps are usually pure Node/browser TypeScript. We
need it because `api-client.ts` references the `Fetcher` global type from
the Workers runtime. Without it, `next build` fails type-checking with:

```
Type error: Cannot find name 'Fetcher'.
```

`tsconfig.json` then needs `"types": ["@cloudflare/workers-types"]` so
the Next.js TypeScript plugin actually picks them up. This is a real
gotcha you'll hit migrating any production Next.js app to OpenNext that
consumes Cloudflare bindings; documenting it here so the next reader
doesn't have to rediscover it.

## Driving the demo on this branch

```bash
# Compare plain Worker callee (default)
curl -s "https://demo-router.<your-subdomain>.workers.dev/" | jq '.summary'

# Compare with the Next.js callee instead
curl -s "https://demo-router.<your-subdomain>.workers.dev/?backend=next" | jq '.summary'

# Forced shortcuts
curl -s "https://demo-router.<your-subdomain>.workers.dev/good-next" | jq '.body'
curl -s "https://demo-router.<your-subdomain>.workers.dev/bad-next"  | jq '.body'

# Host-forwarding diagnostic, going through the binding
curl -s "https://demo-router.<your-subdomain>.workers.dev/good-next?path=/api/whoami&host=tenant-b.saas.example.com" \
  | jq '.body.upstream | {arrivedVia, rawRequestUrl, inboundUrl, derivedTenant}'

# Compare what raw Next.js sees vs what the helper recovers
#   rawRequestUrl.hostname === "undefined"           (OpenNext rewrites this)
#   inboundUrl.hostname    === "tenant-b.internal"   (recovered from x-opennext-initial-url)
#   derivedTenant          === "tenant-b"
```

The same call over `bad-next` will return Cloudflare error 1042 in the
upstream body because of same-account loop detection -- expected, and
consistent with the meeting-notes story.

## When to merge this into `main` vs. keep it separate

My judgement: keep it as a long-lived branch, not a merge target. Reasons:

- The plain-Worker `main` is a 10-minute read for anyone evaluating
  the binding pattern. Adding a Next.js app, React, and the OpenNext
  build pipeline triples the install size and adds two more moving
  pieces (Next.js dev server, OpenNext bundler) to understand before
  the reader gets to the binding lesson.
- The branch carries one piece of OpenNext-specific code
  (`getInboundUrl`) that is *not* needed on `main`. Putting it on
  `main` would either pollute the plain-Worker example or get hidden
  behind a runtime check; both are worse than having a separate branch
  where it belongs.
- The branch is permanently linkable as a self-contained answer to
  "does this pattern work in Next.js, and what are the gotchas?"
  without making everyone who lands on the repo wade through Next.js
  to learn about Service Bindings.
- If OpenNext changes how it handles the inbound host (e.g. starts
  preserving `request.url`), the plain-Worker `main` is unaffected and
  this branch can be updated independently.

If a future use case demands Next.js as the *primary* reference (e.g.
a customer who only ships Next.js), the right move is to publish this
branch as its own repo (e.g.
`cf-service-bindings-cross-zone-proxy-nextjs`) rather than absorb it
into `main`.
