interface Env {
  TENANTS: KVNamespace;
  APP_REGION_1: Fetcher;
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

    const started = Date.now();
    const upstream = await env.APP_REGION_1.fetch(
      `https://${tenant}.internal${downstreamPath}${queryString}`,
    );
    const elapsedMs = Date.now() - started;
    const rawBody = await upstream.text();
    const upstreamBytes = new TextEncoder().encode(rawBody).byteLength;
    const upstreamBody = JSON.parse(rawBody);

    return Response.json({
      proxy: "proxy-production-good",
      transport: "service binding (in-runtime)",
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
