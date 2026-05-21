# cf-service-bindings-cross-zone-proxy

A minimum-viable reference architecture for eliminating cross-zone Worker
sub-request billing in a Cloudflare-for-SaaS multi-tenant topology.

A central proxy Worker (`proxy-production`) receives all tenant traffic
and fans out to one or more regional application Workers (`app-region-1`,
`app-region-2`, ...). Tenant domains CNAME to a single SaaS zone
(`saas.example.com`), so the proxy resolves the inbound `Host` against a
KV tenant map and forwards the request.

> **Zone vs Worker naming.** `saas.example.com` is the *zone* customer
> domains CNAME to, not a Worker name. Workers (`proxy-production`,
> `app-region-1`) are *bound to routes* on the zone but otherwise have no
> concept of "living in" a zone -- which is precisely why "in-zone Worker
> fetches" do not exist as an optimization (see "The problem" below).

## The problem in one sentence

When a Worker calls another Worker by its public hostname (`workers.dev`
or a custom domain on any zone, including its own), the request leaves
the Workers runtime, re-enters the Cloudflare edge, and every byte of
the response is billed as Data Transfer on the egress line.

The only mechanism that keeps the call inside the runtime is a **Service
Binding**. Same-zone vs cross-zone is not a knob you have on `fetch(url)`.

## Topology

```
                         demo-router  (entry point)
                          /         \
              [Service Binding]   [Service Binding]
                   /                       \
        proxy-production-bad           proxy-production-good
          anti-pattern                   recommended
          fetch(workers.dev URL)         env.APP_REGION_1.fetch(host + path)
                   \                       /
                    \                     /
                     app-region-1  (shared regional application worker)
                       tenant routing by Host
                       path routing by URL
                       Vercel-portable api-client adapter
```

Both `proxy-production-*` proxies use the same KV tenant map. The only
difference is *how* they reach `app-region-1`.

In a real `proxy-production` deployment there would be multiple regional
app workers (`app-region-1`, `app-region-2`, `app-region-3`, ...), each
declared as its own `[[services]]` block on the proxy. The binding
mechanics, billing model, and host/path forwarding are identical across
them, so we ship one regional worker in this MVP.

## Quick drive

Once deployed to your own account (see "Deploy" below), the demo router
exposes a single comparison endpoint:

```bash
# Default: host=tenant-a.saas.example.com, path=/api/catalog, size=64 KB
curl -s https://demo-router.<your-subdomain>.workers.dev/ | jq '.summary'

# Different tenant, bigger payload
curl -s "https://demo-router.<your-subdomain>.workers.dev/?host=tenant-b.saas.example.com&size=256" | jq '.summary'

# Each side on its own
curl -s https://demo-router.<your-subdomain>.workers.dev/good | jq '.body'
curl -s https://demo-router.<your-subdomain>.workers.dev/bad  | jq '.body'
```

Sample summary:

```json
{
  "badMs": 28,
  "goodMs": 29,
  "deltaMs": -1,
  "badDataTransferBilledBytes": 16,
  "goodDataTransferBilledBytes": 0,
  "badSubrequestBilled": true,
  "goodSubrequestBilled": false,
  "tenantSeenByGood": "tenant-a",
  "arrivedViaGood": "service binding",
  "note": "host + path are forwarded through the binding intact; the bytes are not billed as Data Transfer and the call is not billed as a sub-request."
}
```

Two fields tell the whole story:

- `goodDataTransferBilledBytes: 0` -- the binding path transferred a 64 KB
  response and Cloudflare bills you for zero bytes.
- `goodSubrequestBilled: false` -- the call also does not count against
  the per-request sub-request limit.

## Host + path survive the binding

`proxy-production-good` calls:

```ts
env.APP_REGION_1.fetch(`https://${tenant}.internal${downstreamPath}${queryString}`)
```

On the callee side (`app-region-1`), `new URL(request.url)` parses out:

- `url.hostname` → `tenant-a.internal` → tenant `"tenant-a"`
- `url.pathname` → `/api/catalog`
- `url.searchParams.get("size")` → `"64"`

The host portion is yours to set; it has no public-DNS meaning over a
binding. Use it however your callee routes (tenant subdomain, region tag,
shard id, anything).

Proof in the response from a `?host=tenant-b.saas.example.com&size=256` call:

```json
{
  "upstreamSvc": "app-region-1",
  "upstreamTenant": "tenant-b",
  "upstreamPath": "/api/catalog",
  "upstreamArrivedVia": "service binding",
  "upstreamSizeKb": 256
}
```

## The code delta

Anti-pattern (`workers/proxy-production-bad/`):

```toml
# wrangler.toml
[vars]
APP_WORKER_URL = "https://app-region-1.<your-subdomain>.workers.dev"

[[kv_namespaces]]
binding = "TENANTS"
id = "<your-tenants-kv-namespace-id>"
```

```ts
// src/index.ts
const upstream = await fetch(
  `${env.APP_WORKER_URL}${downstreamPath}${queryString}`,
  { headers: { host: `${tenant}.internal` } },
);
```

Recommended (`workers/proxy-production-good/`):

```toml
# wrangler.toml
[[services]]
binding = "APP_REGION_1"
service = "app-region-1"

[[kv_namespaces]]
binding = "TENANTS"
id = "<your-tenants-kv-namespace-id>"
```

```ts
// src/index.ts
const upstream = await env.APP_REGION_1.fetch(
  `https://${tenant}.internal${downstreamPath}${queryString}`,
);
```

Three lines of TOML, one line of TypeScript. Everything else (KV lookup,
host construction, query forwarding) is identical.

## Vercel-portable application code

A common constraint for SaaS providers using a hybrid Workers/Vercel
deployment is that the application worker must remain Vercel-deployable
as a fallback. The pattern in `workers/app-region-1/src/api-client.ts`:

```ts
export function getApiClient(env: ApiClientEnv): ApiClient {
  if (env.API) {
    return { get: (path) => env.API!.fetch(`https://internal${path}`) };
  }
  if (env.API_BASE_URL) {
    return { get: (path) => fetch(`${env.API_BASE_URL}${path}`) };
  }
  throw new Error("No API transport configured.");
}
```

Application code calls `getApiClient(env).get("/some/path")` and never
references either transport directly. On Workers, you bind `API` in
`wrangler.toml`. On Vercel/Node, you set the `API_BASE_URL` env var. Same
call sites, swap-in transport.

### Does the same pattern work inside a real Next.js app?

Yes:

- **Producer (Next.js app as a Service Binding target)**: when Next.js is
  deployed to Workers via OpenNext (`@opennextjs/cloudflare`), the resulting
  Worker can be the `service` referenced by another Worker's `[[services]]`
  block. The proxy calls `env.APP_REGION_1.fetch(...)` and the request lands
  in Next.js's standard route handler / middleware / RSC pipeline, with
  `request.url`'s host and path intact -- exactly as demonstrated here by
  `app-region-1`.
- **Consumer (Next.js app calling another Worker)**: inside any server-side
  Next.js code, `getCloudflareContext().env.MY_BINDING.fetch(...)` works
  identically to a plain Worker.
- **Host forwarding**: the host portion of the URL passed to a Service
  Binding is delivered to the callee on `request.url`. Whether the callee
  is a plain Worker or an OpenNext Worker, `new URL(request.url).hostname`
  returns whatever the caller wrote. Host-based tenant resolution keeps
  working.

The same code as in this repo runs unchanged inside a Next.js route
handler on OpenNext, with `env` reached via `getCloudflareContext()`.

## Why this fixes the bill

| Pattern | Billed as Data Transfer? | Billed as a sub-request? |
| --- | --- | --- |
| `fetch("https://other-worker.workers.dev/...")` | Yes | Yes |
| `fetch("https://api.your-zone.com/...")` (still a Worker) | Yes | Yes |
| `fetch("https://third-party.com/...")` (real external) | Yes | Yes |
| `env.OTHER.fetch("https://internal/...")` (Service Binding) | **No** | **No** |
| `env.MY_KV.get(...)`, `env.MY_R2.get(...)`, `env.MY_D1...` | **No** | **No** (resource billing applies) |

If Data Transfer is dominated by Worker-to-Worker traffic inside one
account, the remediation is to delete those `fetch(url)` calls and replace
them with bindings. The code delta in this repo is the migration template.

## Run locally

```bash
npm install

# Terminal 1 -- the callee
npm run dev:app      # http://localhost:8788  (app-region-1)

# Terminal 2 -- anti-pattern proxy
npm run dev:bad      # http://localhost:8787  (proxy-production-bad)

# Terminal 3 -- recommended proxy
npm run dev:good     # http://localhost:8789  (proxy-production-good)

# Terminal 4 -- the router (the one you curl)
npm run dev:router   # http://localhost:8790  (demo-router)
```

Then:

```bash
curl http://localhost:8790/ | jq
```

## Deploy

Before deploying, fill in the placeholders in the wrangler.toml files:

- `workers/proxy-production-bad/wrangler.toml`:
  - `APP_WORKER_URL` -- replace `<your-subdomain>` with your `workers.dev` subdomain.
  - `[[kv_namespaces]] id` -- replace with the id from `wrangler kv:namespace create TENANTS`.
- `workers/proxy-production-good/wrangler.toml`:
  - `[[kv_namespaces]] id` -- same as above (reuse the namespace).

Seed the KV namespace with a few tenants:

```bash
wrangler kv:key put --binding=TENANTS "tenant-a.saas.example.com" "tenant-a"
wrangler kv:key put --binding=TENANTS "tenant-b.saas.example.com" "tenant-b"
wrangler kv:key put --binding=TENANTS "tenant-c.saas.example.com" "tenant-c"
```

Then:

```bash
npm run deploy:all
```

Deploy order matters and is enforced in the script (Service Bindings are
validated at deploy time):

1. `app-region-1`
2. `proxy-production-bad`, `proxy-production-good`
3. `demo-router`

### Prove it: take the callee off the public internet

The single strongest demonstration of why bindings beat `fetch()` is to
make `app-region-1` private (no `workers.dev` URL) and watch the two
proxies diverge: `good` keeps working, `bad` breaks.

```bash
npm run private:status    # show current workers_dev value for app-region-1
npm run private:on        # workers_dev = false, then redeploy app-region-1
curl https://demo-router.<your-subdomain>.workers.dev/ | jq '.summary'
#   goodSubrequestBilled: false, transport still works
#   bad side returns an upstream error (no public URL to fetch)
npm run private:off       # back to workers_dev = true
```

Two npm scripts (`private:on`, `private:off`) wrap a single Node helper
at `scripts/toggle-private.mjs` that flips the `workers_dev` line in
`workers/app-region-1/wrangler.toml` and redeploys just that worker.
Both scripts are idempotent and print the current state. This is the
runnable version of the security argument from the meeting notes:
*"internal workers can be taken off the public internet entirely,
exposing the endpoint only on the Cloudflare data plane via the
binding."*

## Query parameters on the demo

All are accepted by `demo-router` and forwarded to both proxies:

| Param | Default | Description |
| --- | --- | --- |
| `host` | `tenant-a.saas.example.com` | Simulated incoming `Host` header; looked up in KV |
| `path` | `/api/catalog` | Downstream route on `app-region-1` |
| `size` | `64` | Payload size in KB for `/api/catalog` (0-1024) |

Suggested tenants to seed in KV: `tenant-a.saas.example.com`,
`tenant-b.saas.example.com`, `tenant-c.saas.example.com`.

## Further reading

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers bindings overview](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
- [Sub-request limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
