import type { ApiClientEnv } from "./api-client";

interface Env extends ApiClientEnv {}

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

    return Response.json(
      {
        service: "app-region-1",
        tenant,
        path: url.pathname,
        arrivedVia,
        error: "unknown route",
        availableRoutes: ["/api/catalog?size=KB"],
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

function clampSize(raw: string | null): number {
  const n = Number(raw ?? 64);
  if (!Number.isFinite(n)) return 64;
  return Math.min(Math.max(n, 0), 1024);
}
