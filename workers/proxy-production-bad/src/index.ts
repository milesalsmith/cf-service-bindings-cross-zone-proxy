interface Env {
  TENANTS: KVNamespace;
  APP_WORKER_URL: string;
  APP_WORKER_NEXT_URL: string;
}

type Backend = "plain" | "next";

function pickBackendUrl(env: Env, backend: Backend): { url: string; service: string } {
  return backend === "next"
    ? { url: env.APP_WORKER_NEXT_URL, service: "app-region-1-next" }
    : { url: env.APP_WORKER_URL, service: "app-region-1" };
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

    const { url: appWorkerUrl, service } = pickBackendUrl(env, backend);

    const started = Date.now();
    const upstream = await fetch(
      `${appWorkerUrl}${downstreamPath}${queryString}`,
      { headers: { host: `${tenant}.internal` } },
    );
    const elapsedMs = Date.now() - started;
    const rawBody = await upstream.text();
    const upstreamBytes = new TextEncoder().encode(rawBody).byteLength;

    let upstreamBody: unknown = rawBody;
    let upstreamError: string | undefined;
    try {
      upstreamBody = JSON.parse(rawBody);
    } catch {
      upstreamError = /error code:\s*1042/i.test(rawBody)
        ? "Cloudflare error 1042: same-account public-hostname loop refused by the edge. Use a Service Binding."
        : `Non-JSON upstream response (status ${upstream.status})`;
    }

    return Response.json({
      proxy: "proxy-production-bad",
      transport: "public fetch() (cross-zone)",
      backend,
      backendService: service,
      outsideHost,
      tenant,
      downstreamPath,
      elapsedMs,
      upstreamStatus: upstream.status,
      upstreamBytes,
      dataTransferBilledBytes: upstreamBytes,
      subrequestBilled: true,
      upstreamError,
      upstream: upstreamBody,
    });
  },
} satisfies ExportedHandler<Env>;
