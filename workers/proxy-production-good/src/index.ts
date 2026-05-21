interface Env {
  TENANTS: KVNamespace;
  APP_REGION_1: Fetcher;
  APP_REGION_1_NEXT: Fetcher;
}

type Backend = "plain" | "next";

function pickBackend(env: Env, backend: Backend): { fetcher: Fetcher; service: string } {
  return backend === "next"
    ? { fetcher: env.APP_REGION_1_NEXT, service: "app-region-1-next" }
    : { fetcher: env.APP_REGION_1, service: "app-region-1" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const outsideHost = url.searchParams.get("host") ?? url.hostname;
    const tenant = await env.TENANTS.get(outsideHost);

    if (!tenant) {
      return Response.json({ error: "unknown tenant", outsideHost }, { status: 404 });
    }

    const downstreamPath = url.searchParams.get("path") ?? "/api/catalog";
    const sizeParam = url.searchParams.get("size");
    const queryString = sizeParam ? `?size=${sizeParam}` : "";
    const backend: Backend = url.searchParams.get("backend") === "next" ? "next" : "plain";

    const { fetcher, service } = pickBackend(env, backend);

    const started = Date.now();
    const upstream = await fetcher.fetch(
      `https://${tenant}.internal${downstreamPath}${queryString}`,
    );
    const elapsedMs = Date.now() - started;
    const rawBody = await upstream.text();
    const upstreamBytes = new TextEncoder().encode(rawBody).byteLength;

    let upstreamBody: unknown = rawBody;
    try {
      upstreamBody = JSON.parse(rawBody);
    } catch {
      /* leave as text */
    }

    return Response.json({
      proxy: "proxy-production-good",
      transport: "service binding (in-runtime)",
      backend,
      backendService: service,
      outsideHost,
      tenant,
      downstreamPath,
      elapsedMs,
      upstreamStatus: upstream.status,
      upstreamBytes,
      dataTransferBilledBytes: 0,
      subrequestBilled: false,
      upstream: upstreamBody,
    });
  },
} satisfies ExportedHandler<Env>;
