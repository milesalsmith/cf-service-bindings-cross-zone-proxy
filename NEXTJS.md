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

**Yes.** The caller is free to set the URL's host portion to anything;
the runtime delivers it intact to the callee on `request.url`. The
Next.js callee parses it with a standard `new URL(request.url)`.

This branch makes the claim observable. `/api/whoami` returns:

```jsonc
{
  "service": "app-region-1-next",
  "runtime": "next.js on opennext/cloudflare",
  "arrivedVia": "service binding",
  "parsedUrl": {
    "hostname": "tenant-b.internal",        // <- caller wrote this; delivered intact
    "pathname": "/api/whoami",
    "search": ""
  },
  "derivedTenant": "tenant-b",
  "headers": { /* every header the Next.js route handler sees */ }
}
```

Compare against hitting the same handler via `proxy-production-bad`,
which goes over the public edge: `arrivedVia` becomes `"public edge"`,
`parsedUrl.hostname` reflects the public `workers.dev` URL, and
`cf-connecting-ip` is set. That diff is the single clearest before/after
for the binding model.

## What was validated locally on this branch

The full Next.js + OpenNext build chain was executed end-to-end before
this branch was pushed:

1. `npm install` -- installs Next.js 15, React 18, `@opennextjs/cloudflare`,
   and `@cloudflare/workers-types` in the new workspace.
2. `npm --workspace workers/app-region-1-next run build` -- runs `next build`.
   Both route handlers are correctly recognised as `ƒ Dynamic` (server-rendered
   on demand), which is required for them to be reachable via a Service
   Binding.
3. `npx opennextjs-cloudflare build` -- produces `.open-next/worker.js`.
   Reports "OpenNext build complete" with no errors.
4. `wrangler deploy --dry-run` on each plain Worker -- confirms that
   `proxy-production-good`'s bindings now include both
   `APP_REGION_1: app-region-1` and `APP_REGION_1_NEXT: app-region-1-next`,
   and that `proxy-production-bad` has both `APP_WORKER_URL` and
   `APP_WORKER_NEXT_URL` set.

Actual deployment to your account requires you to fill in the placeholders
(KV namespace id, `workers.dev` subdomain) and run `npm run deploy:all`.
The deploy order is encoded in the script so bindings validate at deploy
time:

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

# Andrew's host-forwarding diagnostic, going through the binding
curl -s "https://demo-router.<your-subdomain>.workers.dev/good-next?path=/api/whoami&host=tenant-b.saas.example.com" \
  | jq '.body.upstream.parsedUrl, .body.upstream.derivedTenant, .body.upstream.arrivedVia'

# Same diagnostic, going over the public edge
curl -s "https://demo-router.<your-subdomain>.workers.dev/bad-next?path=/api/whoami&host=tenant-b.saas.example.com" \
  | jq '.body.upstream.parsedUrl, .body.upstream.derivedTenant, .body.upstream.arrivedVia'
```

The second-to-last call returns `arrivedVia: "service binding"` and
`hostname: "tenant-b.internal"`. The last call returns
`arrivedVia: "public edge"` and `hostname` set to whatever
`workers.dev` URL was used. That's the proof Andrew asked for.

## When to merge this into `main` vs. keep it separate

My judgement: keep it as a long-lived branch, not a merge target. Reasons:

- The plain-Worker `main` is a 10-minute read for anyone evaluating
  the binding pattern. Adding a Next.js app, React, and the OpenNext
  build pipeline triples the install size and adds two more moving
  pieces (Next.js dev server, OpenNext bundler) to understand before
  the reader gets to the binding lesson.
- The branch is permanently linkable as a self-contained answer to
  "does this pattern work in Next.js?" without making everyone who
  lands on the repo wade through Next.js to learn about Service Bindings.
- If OpenNext's API changes (it's pre-1.x), the plain-Worker `main`
  keeps working untouched, and this branch can be updated independently.

If a future use case demands Next.js as the *primary* reference (e.g.,
a customer who only ships Next.js), the right move is to publish this
branch as its own repo (e.g. `cf-service-bindings-cross-zone-proxy-nextjs`)
rather than absorb it into `main`.
