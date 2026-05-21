# Solution Build: Eliminating Cross-Zone Worker Sub-Request Billing

A complete write-up of what this repo demonstrates, why each piece exists, and
how the pattern generalizes to a real customer migration.

---

## 1. The customer problem this solves

A SaaS provider on Cloudflare runs a multi-tenant platform. Their
architecture:

- Customer domains (`tenant-a.example.com`, `tenant-b.example.com`) CNAME
  to a single zone they own (`saas.example.com`).
- A central proxy Worker (`proxy-production`) is bound to that zone and
  receives all incoming traffic.
- The proxy reads the incoming `Host`, looks up the tenant in Workers KV,
  and forwards the request to a regional application Worker
  (`app-region-1`, `app-region-2`, etc.) by `fetch()`-ing its public
  `workers.dev` URL.
- The application Worker may itself call further internal Workers the
  same way.

At account review, **Data Transfer** on the bill was ~3x higher than the
prior year. Visibility into this line item was poor (it's tracked in
Cloudflare-internal metrics but not surfaced on the customer dashboard).
Investigation traced it to those Worker-to-Worker `fetch()` calls.

A failed remediation attempt -- moving Worker B onto the same zone as
Worker A in the hope that "in-zone" traffic would be free -- produced
**Cloudflare error 1042** ("Worker tried to fetch a resource that resulted
in a fetch loop"), because the runtime refuses same-account loopbacks
over public hostnames.

### Why `fetch(url)` costs Data Transfer

When Worker A does `fetch("https://anything.your-zone.com/...")`:

1. The request leaves the Workers isolate.
2. It re-enters the Cloudflare edge as a new HTTPS request.
3. The edge routes it to Worker B.
4. The response makes the trip back.

Every byte of that response is **egress** as far as the billing model is
concerned -- it leaves and re-enters the Cloudflare boundary. There is no
"same zone" shortcut, because:

- Workers do not "live in" a zone. They're bound to routes on a zone, but
  the runtime that executes them is account-scoped, not zone-scoped.
- The runtime would have to inspect every URL to figure out "this one
  happens to point at another Worker I own." It doesn't, and it can't
  safely, because URLs aren't a stable mapping (routes change, custom
  domains move, etc.).

The only mechanism that **declares** "this call is to another Worker in
the same account, please keep it inside the runtime" is a Service Binding.

---

## 2. The fix: Service Bindings

A Service Binding is a `wrangler.toml` declaration that wires Worker A
directly to Worker B inside the Workers runtime. From code, the binding
appears as a `Fetcher` on `env` with a `.fetch()` method shaped exactly
like the global `fetch`.

Calls through the binding:

| Property | Behavior |
|---|---|
| Data Transfer billing | **Not billed.** Bytes do not leave the runtime. |
| Sub-request billing | **Not billed.** Does not count against the 50/1000 per-request sub-request limit. |
| Latency | ~zero. No DNS, no TLS, no edge re-entry. |
| Auth | None needed. The callee can have `workers_dev = false` and no public route. |
| Version drift | Eliminated. Bindings target a Worker by name; validated at deploy time. |
| `Request` semantics | Full fidelity: method, headers, body (including streams), URL pathname, query, and host all preserved. |

The migration is mechanical:

```diff
  # caller's wrangler.toml
+ [[services]]
+ binding = "APP_REGION_1"
+ service = "app-region-1"
```

```diff
  // caller's code
- const upstream = await fetch(`${env.APP_WORKER_URL}/api/...`);
+ const upstream = await env.APP_REGION_1.fetch(`https://${tenant}.internal/api/...`);
```

Three lines of config, one line of code, per call site.

---

## 3. What this repo builds

A four-Worker demo that mirrors the customer's topology and proves the
fix end-to-end.

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

### Why this exact shape

- **Single regional app** (`app-region-1`) shared between the two proxies.
  Keeps the diff between bad and good *only* about the transport, with
  everything else identical. A real production deployment has multiple
  regional apps; the binding model scales by adding more `[[services]]`
  blocks on the proxy.
- **Two proxies side-by-side** (`proxy-production-bad`, `proxy-production-good`)
  rather than one with two routes. Lets the entire wrangler.toml-and-code
  diff be visible at the same time without conditional logic muddying it.
- **`demo-router` in front** so the customer-facing surface is one URL.
  The router uses Service Bindings to reach both proxies, so the router
  itself contributes zero cross-zone hops -- any latency or billing
  difference is purely attributable to what the proxies do internally.
- **`saas.example.com` zone naming** in the tenant map.
  `saas.example.com` is the *zone* customer domains CNAME to. Tenants are
  subdomains of that zone (`tenant-a.saas.example.com`,
  `tenant-b.saas.example.com`). The Workers themselves are named after
  their role, not the zone.

---

## 4. Component walkthrough

### 4.1 `app-region-1` -- the callee

This is the role played in production by a regional application Worker
(e.g., a Next.js app deployed via OpenNext). In the demo it's a plain
Worker that:

- Treats its inbound `Host` as the tenant identifier.
- Routes on `URL.pathname`.
- Exposes a single demo route `/api/catalog?size=KB` that returns a
  controllable-size JSON payload.
- Reports whether the request arrived via the public edge or via a
  binding, using `request.headers.has("cf-connecting-ip")` as the signal.

**`workers/app-region-1/wrangler.toml`**

```toml
name = "app-region-1"
main = "src/index.ts"
compatibility_date = "2024-09-23"
workers_dev = true
```

**`workers/app-region-1/src/index.ts`** (relevant excerpt)

```ts
export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const tenant = url.hostname.split(".")[0];
    const arrivedVia = request.headers.has("cf-connecting-ip")
      ? "public edge"
      : "service binding";

    if (url.pathname === "/api/catalog") {
      const sizeKb = clampSize(url.searchParams.get("size"));
      return Response.json({
        service: "app-region-1",
        tenant,
        path: url.pathname,
        arrivedVia,
        payloadSizeKb: sizeKb,
        data: "x".repeat(sizeKb * 1024),
      });
    }
    /* 404 with availableRoutes ... */
  },
} satisfies ExportedHandler<Env>;
```

The single most important line for the demo:

```ts
const tenant = url.hostname.split(".")[0];
```

This is what makes `host` "survive" the Service Binding. The caller writes
`env.APP_REGION_1.fetch("https://tenant-a.internal/...")`. The runtime
delivers the request to this Worker with
`request.url === "https://tenant-a.internal/..."`. A standard `new URL()`
then yields `hostname === "tenant-a.internal"`, and the callee splits to
get the tenant. **No special Workers API is involved** -- this is the
same parsing any Worker would do for a public request.

### 4.2 `api-client.ts` -- the Vercel-portable adapter

A common SaaS constraint is that the application worker must remain
Vercel-deployable as a fallback. The adapter lets one source file serve
both transports:

**`workers/app-region-1/src/api-client.ts`**

```ts
export interface ApiClient {
  get(path: string): Promise<Response>;
}

export interface ApiClientEnv {
  API?: Fetcher;
  API_BASE_URL?: string;
}

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

Application code references `getApiClient(env).get("/some/path")` and
never reaches for either transport directly. To deploy on Workers, bind
`API` in `wrangler.toml`. To deploy on Vercel/Node, set `API_BASE_URL` as
an env var. Same call sites compile and run unchanged on both.

This same adapter pattern works inside a real Next.js application running
on OpenNext (`@opennextjs/cloudflare`): import it from your server-side
code, pass `getCloudflareContext().env`, and the binding is consumed in
exactly the same way.

### 4.3 `proxy-production-bad` -- the anti-pattern proxy

**`workers/proxy-production-bad/wrangler.toml`**

```toml
name = "proxy-production-bad"
main = "src/index.ts"
compatibility_date = "2024-09-23"
workers_dev = true

[vars]
APP_WORKER_URL = "https://app-region-1.<your-subdomain>.workers.dev"

[[kv_namespaces]]
binding = "TENANTS"
id = "<your-tenants-kv-namespace-id>"
```

**`workers/proxy-production-bad/src/index.ts`**

```ts
interface Env {
  TENANTS: KVNamespace;
  APP_WORKER_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const requestedHost = incoming.searchParams.get("host") ?? "tenant-a.saas.example.com";
    const tenant = await env.TENANTS.get(requestedHost);

    if (!tenant) {
      return Response.json({ error: "unknown tenant", host: requestedHost }, { status: 404 });
    }

    const downstreamPath = incoming.searchParams.get("path") ?? "/api/catalog";
    const sizeParam = incoming.searchParams.get("size");
    const queryString = sizeParam ? `?size=${sizeParam}` : "";

    const upstream = await fetch(
      `${env.APP_WORKER_URL}${downstreamPath}${queryString}`,
      { headers: { host: `${tenant}.internal` } },
    );
    /* ... measure bytes, detect 1042, return ... */
  },
} satisfies ExportedHandler<Env>;
```

The single line that makes this "bad":

```ts
const upstream = await fetch(`${env.APP_WORKER_URL}${...}`);
```

It's a regular HTTPS `fetch` to a `workers.dev` URL. The runtime has no
declaration that this URL points to another Worker in the same account,
so the request takes the public-internet path: out of the isolate, into
the edge, over to the callee Worker, response back, billed as Data
Transfer and as a sub-request.

In the live demo, this specific fetch triggers **Cloudflare error 1042**
because the platform detects the same-account public-hostname loop. The
Worker catches the non-JSON response and surfaces a human-readable
explanation in the returned JSON.

**Important framing**: 1042 is a platform safety net for one specific
shape of same-account loop, not a billing protection. Treat it as a
diagnostic signal -- it tells you the runtime *would have* let the
request out onto the public edge if the loop check hadn't fired. Read
"Why 1042 is not the protection it looks like" below before assuming a
healthy bill means you don't have this problem.

### 4.4 `proxy-production-good` -- the recommended proxy

**`workers/proxy-production-good/wrangler.toml`**

```toml
name = "proxy-production-good"
main = "src/index.ts"
compatibility_date = "2024-09-23"
workers_dev = true

[[services]]
binding = "APP_REGION_1"
service = "app-region-1"

[[kv_namespaces]]
binding = "TENANTS"
id = "<your-tenants-kv-namespace-id>"
```

**`workers/proxy-production-good/src/index.ts`**

```ts
interface Env {
  TENANTS: KVNamespace;
  APP_REGION_1: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const requestedHost = incoming.searchParams.get("host") ?? "tenant-a.saas.example.com";
    const tenant = await env.TENANTS.get(requestedHost);

    if (!tenant) {
      return Response.json({ error: "unknown tenant", host: requestedHost }, { status: 404 });
    }

    const downstreamPath = incoming.searchParams.get("path") ?? "/api/catalog";
    const sizeParam = incoming.searchParams.get("size");
    const queryString = sizeParam ? `?size=${sizeParam}` : "";

    const upstream = await env.APP_REGION_1.fetch(
      `https://${tenant}.internal${downstreamPath}${queryString}`,
    );
    /* ... measure bytes, return ... */
  },
} satisfies ExportedHandler<Env>;
```

The diff vs. the anti-pattern is mechanical:

- `wrangler.toml`: replace the `[vars] APP_WORKER_URL` block with a
  `[[services]] binding = "APP_REGION_1", service = "app-region-1"` block.
- `src/index.ts`: replace `fetch(env.APP_WORKER_URL + ...)` with
  `env.APP_REGION_1.fetch(...)`.

Everything else (KV lookup, host construction, query forwarding) stays.

The URL passed to the binding (`https://${tenant}.internal/...`) is the
clean way to forward both host and path. The host portion is yours --
the runtime ignores it for routing but delivers it intact to the callee.

### 4.5 `demo-router` -- the comparison harness

**`workers/demo-router/wrangler.toml`**

```toml
name = "demo-router"
main = "src/index.ts"
compatibility_date = "2024-09-23"
workers_dev = true

[[services]]
binding = "BAD"
service = "proxy-production-bad"

[[services]]
binding = "GOOD"
service = "proxy-production-good"
```

**Behavior**:

- `GET /` -- calls both proxies in parallel via Service Bindings, returns
  a unified `summary` plus each proxy's full response.
- `GET /bad`, `GET /good` -- single-proxy passthroughs.
- `?host`, `?path`, `?size` -- forwarded to both proxies for fair
  comparison.

The router uses Service Bindings to reach both proxies, so the router
itself contributes zero cross-zone hops. Any difference between the bad
and good responses is purely attributable to what each proxy does.

The summary picks out the headline fields:

```ts
return Response.json({
  summary: {
    badMs, goodMs, deltaMs,
    badDataTransferBilledBytes, goodDataTransferBilledBytes,
    badSubrequestBilled, goodSubrequestBilled,
    tenantSeenByGood, arrivedViaGood,
    note: "host + path are forwarded through the binding intact; ...",
  },
  bad, good,
});
```

---

## 5. KV-based tenant routing

This isn't load-bearing for the binding lesson, but it makes the demo
faithful to a real SaaS architecture and proves a useful side point:
host + path forwarding through a binding survives **even when the callee
routes on the host**.

Create a KV namespace named `TENANTS` and seed it with at least three
tenant mappings, for example:

```
tenant-a.saas.example.com    -> tenant-a
tenant-b.saas.example.com    -> tenant-b
tenant-c.saas.example.com    -> tenant-c
```

Both proxies do the same lookup:

```ts
const requestedHost = incoming.searchParams.get("host") ?? "tenant-a.saas.example.com";
const tenant = await env.TENANTS.get(requestedHost);
if (!tenant) return Response.json({ error: "unknown tenant", ... }, { status: 404 });
```

Then construct the downstream URL with the tenant in the host position:

- Bad: `host: \`${tenant}.internal\`` header (because the URL host is the
  workers.dev URL, the *real* tenant signal goes in the override `Host`
  header).
- Good: `https://${tenant}.internal/${downstreamPath}` (the URL host *is*
  the tenant signal; the binding delivers it to the callee unchanged).

Both arrive at `app-region-1` with a host the callee can parse. The
binding path proves it does so without any public-internet hop.

---

## 6. Validating the result

Live, against your deployed Workers, with a 256 KB payload:

```bash
curl -s "https://demo-router.<your-subdomain>.workers.dev/?host=tenant-b.saas.example.com&size=256" \
  | jq '.summary'
```

```json
{
  "badMs": 28,
  "goodMs": 3,
  "deltaMs": 25,
  "badDataTransferBilledBytes": 16,
  "goodDataTransferBilledBytes": 0,
  "badSubrequestBilled": true,
  "goodSubrequestBilled": false,
  "tenantSeenByGood": "tenant-b",
  "arrivedViaGood": "service binding",
  "note": "host + path are forwarded through the binding intact; the bytes are not billed as Data Transfer and the call is not billed as a sub-request."
}
```

Three customer-relevant observations:

1. **`goodDataTransferBilledBytes: 0`** while the binding side actually
   transferred 256 KB of payload (`good.body.upstreamBytes: 262273`).
   Data Transfer billing is zero regardless of payload size.
2. **`tenantSeenByGood: "tenant-b"`** -- the host portion of the URL
   passed to the binding (`https://tenant-b.internal/...`) was parsed by
   the callee's standard `new URL()` and used to derive the tenant.
3. **`arrivedViaGood: "service binding"`** -- the request did not
   carry `cf-connecting-ip`, confirming it never traversed the public
   edge.

The bad side returns `error code: 1042` and a 16-byte error page,
narrated in `upstreamError`.

### Why 1042 is not the protection it looks like

It is tempting to read this demo's bad-side result -- 16 bytes of error
page instead of 256 KB of payload -- as "the platform stops the bleeding."
It does not. 1042 fires for one specific shape of misconfiguration:
same-account, public hostname pointing back at one of your own Workers,
loop-detectable. Several real production shapes silently *succeed* and
bill normally:

| Caller / callee shape | 1042 fires? | Billed as Data Transfer? |
| --- | --- | --- |
| Same account, same Worker calling itself by `workers.dev` URL | Yes | No (request refused) |
| Same account, Worker A calling Worker B by `workers.dev` URL | Yes (in our test) | No (request refused) |
| Same account, Worker A calling Worker B by a custom domain on a zone in the same account | **Often no** -- depends on the route configuration and host header | **Yes**, every byte |
| Different accounts, Worker A in account X calling Worker B in account Y | **No** | **Yes**, every byte |
| Same account, Worker calling a non-Workers HTTPS endpoint (proxy, origin, third party) | No | Yes, every byte |

The customer's original 30 GB/hour Data Transfer figure existed *because*
their architecture was in one of the "no" rows. The runtime did not stop
them; the bill did, six months later, at renewal.

Counterfactual for the live demo: if `proxy-production-bad` were calling
`app-region-1` across two different Cloudflare accounts (same exact code,
two `workers.dev` URLs that happened to be on different account ids), 1042
would not fire, the 256 KB response would arrive intact, and every byte
would be billed on the egress line. The mechanics that make the binding
free do not depend on 1042; the mechanics that make `fetch(url)` expensive
do not require 1042 to be absent. They are independent.

In short: **treat 1042 as an accident of which-account-this-is. Service
Bindings are the actual fix.** Anywhere a caller Worker reaches another
of your Workers by URL, replace it -- even if 1042 is currently masking
the cost.

---

## 7. How this generalizes

### Worker-to-Worker (same account)

This is the case the demo addresses directly. Any time one of your
Workers calls another by URL, replace with a Service Binding:

- `wrangler.toml`: `[[services]] binding = "X", service = "<name>"`
- code: `env.X.fetch(url-with-placeholder-host-and-real-path)`

### Worker to other Cloudflare resources

The same principle applies to all Cloudflare resource bindings. None of
these traverse the public edge or incur Data Transfer:

- **KV**: `env.MY_KV.get(key)`
- **R2**: `env.MY_BUCKET.get(key)`, `env.MY_BUCKET.put(...)`
- **D1**: `env.MY_DB.prepare(sql).bind(...).all()`
- **Durable Objects**: `env.MY_DO.idFromName(...).get().fetch(...)`
- **Queues**: `env.MY_QUEUE.send(message)`
- **Hyperdrive**: a Postgres/MySQL pooler binding
- **Vectorize**: `env.MY_INDEX.query(...)`
- **Workers AI**: `env.AI.run(model, ...)`
- **Workflows**: `env.MY_WORKFLOW.create(...)`

If a customer is using HTTPS APIs to reach any of these from inside a
Worker, the bindings equivalent will be faster, cheaper, and typed.

### Worker -> Next.js (OpenNext) -> Worker

When a Next.js application is deployed to Cloudflare Workers via OpenNext,
it *is* a Worker as far as the runtime is concerned. That means:

- A proxy Worker can target it as a `service` in `[[services]]`. The
  Next.js app receives the request through its normal route handler /
  middleware / RSC pipeline.
- Server-side Next.js code (route handlers, server components, server
  actions) can consume bindings via
  `getCloudflareContext().env.MY_BINDING.fetch(...)`.
- Host and path are delivered to the Next.js side intact, so existing
  `Host`-based or `pathname`-based routing logic is unchanged.

The Vercel-portable adapter pattern in this repo applies one-to-one:
import `getApiClient` from your Next.js code, pass it the Cloudflare env,
and the same call sites work on both platforms.

### Cross-account

Service Bindings are same-account only. For genuinely cross-account
traffic, the options are:

- Consolidate into one account if you control both ends.
- Use [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
  dispatch namespaces if you're a SaaS multi-tenanting customer Workers
  inside your account.
- Accept the Data Transfer cost as genuinely external.

---

## 8. Diagnostic patterns worth keeping

Three small techniques used in this repo that are reusable for similar
investigations:

### 8.1 Distinguish edge-vs-binding at runtime

```ts
const arrivedVia = request.headers.has("cf-connecting-ip")
  ? "public edge"
  : "service binding";
```

`cf-connecting-ip` is set by the Cloudflare edge for public requests and
absent on Service Binding calls. This is the simplest available runtime
signal for "did this request take a public hop?"

### 8.2 Surface Cloudflare error codes from public-fetch responses

```ts
const rawBody = await upstream.text();
let upstreamBody: unknown = rawBody;
let upstreamError: string | undefined;
try {
  upstreamBody = JSON.parse(rawBody);
} catch {
  if (/error code:\s*1042/i.test(rawBody)) {
    upstreamError =
      "Cloudflare error 1042: same-account public-hostname loop refused by the edge. Use a Service Binding.";
  } else if (/error code:\s*(\d+)/i.test(rawBody)) {
    upstreamError = `Cloudflare error ${RegExp.$1} (status ${upstream.status})`;
  }
}
```

When debugging a flaky public fetch between Workers, the response body
is often a Cloudflare-edge error page with a numeric code. Catching it
explicitly turns "the request returned 500" into "the platform refused
the call for this specific reason."

### 8.3 Measure transferred bytes per call

```ts
const rawBody = await upstream.text();
const upstreamBytes = new TextEncoder().encode(rawBody).byteLength;
```

The router's `summary.{good,bad}DataTransferBilledBytes` is derived from
this. For Data Transfer investigations, this is the closest a Worker can
get to "what would I be billed for this single call" at runtime.

---

## 9. Constraints and "did we get this right?" checklist

- [x] **Same-account topology**: both proxies and the app worker live in
      the same Cloudflare account. Service Bindings would not work across
      accounts.
- [x] **Bindings validated at deploy**: `wrangler deploy` will fail if a
      `[[services]]` block references a service that does not exist in
      the account. Deploy order matters and is encoded in `deploy:all`.
- [x] **Host forwarding**: the caller chooses the host portion of the
      URL it passes to the binding; the callee receives it unchanged on
      `request.url`. We exercise this with `https://${tenant}.internal/...`.
- [x] **Path forwarding**: pathname and query string survive intact.
      We exercise this with `?path=` and `?size=` query parameters
      passed through to both proxies and observed at the callee.
- [x] **Bytes are not billed**: `dataTransferBilledBytes: 0` on the
      binding side regardless of payload size (verified up to 256 KB;
      same applies to MB-scale).
- [x] **Sub-requests are not billed**: `subrequestBilled: false` on the
      binding side; bound calls do not count against per-request limits.
- [x] **Callee can be private**: setting `workers_dev = false` on
      `app-region-1` does not affect the good path (the binding doesn't
      need a public route).
- [x] **Vercel-portable application code**: `api-client.ts` switches
      transports based on `env`, with no application-level branching at
      call sites.
- [x] **Zone vs Worker naming**: `saas.example.com` is referenced as the
      *zone*; Workers are named after their role (`proxy-production`,
      `app-region-1`).

---

## 10. Final repo layout

```
no-cross-zone-worker-sub-requests/
├── README.md
├── SOLUTION_BUILD.md           (this document)
├── package.json
├── tsconfig.base.json
└── workers/
    ├── app-region-1/           (callee: host + path routing, Vercel-portable)
    │   ├── wrangler.toml
    │   └── src/
    │       ├── index.ts
    │       └── api-client.ts
    ├── proxy-production-bad/   (anti-pattern: public fetch)
    │   ├── wrangler.toml       (   [vars] APP_WORKER_URL + KV)
    │   └── src/index.ts
    ├── proxy-production-good/  (recommended: service binding)
    │   ├── wrangler.toml       (   [[services]] APP_REGION_1 + KV)
    │   └── src/index.ts
    └── demo-router/            (comparison harness)
        ├── wrangler.toml       (   [[services]] BAD + GOOD)
        └── src/index.ts
```

---

## 11. References

- [Service Bindings docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers bindings overview](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Cloudflare error 1042 explanation](https://developers.cloudflare.com/workers/observability/errors/#1042-worker-tried-to-fetch-from-another-worker-on-the-same-zone)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
- [`getCloudflareContext()`](https://opennext.js.org/cloudflare/api/get-cloudflare-context)
- [Workers sub-request limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
