interface Env {
  BAD: Fetcher;
  GOOD: Fetcher;
}

type ProxyResult = {
  status: number;
  elapsedMs: number;
  body: Record<string, unknown> | string;
};

async function callProxy(fetcher: Fetcher, query: string): Promise<ProxyResult> {
  const started = Date.now();
  const res = await fetcher.fetch(`https://proxy/${query}`);
  const text = await res.text();
  let body: ProxyResult["body"] = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, elapsedMs: Date.now() - started, body };
}

function pick<T = unknown>(body: ProxyResult["body"], key: string): T | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as Record<string, unknown>)[key];
  return v === undefined ? null : (v as T);
}

function withBackend(query: string, backend: "plain" | "next"): string {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  params.set("backend", backend);
  return "?" + params.toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const query = url.search;

    switch (url.pathname) {
      case "/bad":
        return jsonOf(await callProxy(env.BAD, query));

      case "/good":
        return jsonOf(await callProxy(env.GOOD, query));

      // Shortcuts that force the Next.js callee regardless of caller's
      // backend= param. Useful when comparing the OpenNext path head-on.
      case "/bad-next":
        return jsonOf(await callProxy(env.BAD, withBackend(query, "next")));

      case "/good-next":
        return jsonOf(await callProxy(env.GOOD, withBackend(query, "next")));

      case "/":
      case "/compare": {
        const [bad, good] = await Promise.all([
          callProxy(env.BAD, query),
          callProxy(env.GOOD, query),
        ]);

        return Response.json({
          summary: {
            badMs: bad.elapsedMs,
            goodMs: good.elapsedMs,
            deltaMs: bad.elapsedMs - good.elapsedMs,
            badDataTransferBilledBytes: pick<number>(bad.body, "dataTransferBilledBytes"),
            goodDataTransferBilledBytes: pick<number>(good.body, "dataTransferBilledBytes"),
            badSubrequestBilled: pick<boolean>(bad.body, "subrequestBilled"),
            goodSubrequestBilled: pick<boolean>(good.body, "subrequestBilled"),
            backend: pick<string>(good.body, "backend"),
            backendService: pick<string>(good.body, "backendService"),
            tenantSeenByGood: pick<string>(
              pick<ProxyResult["body"]>(good.body, "upstream") ?? null,
              "tenant",
            ),
            arrivedViaGood: pick<string>(
              pick<ProxyResult["body"]>(good.body, "upstream") ?? null,
              "arrivedVia",
            ),
            note:
              "host + path are forwarded through the binding intact; the bytes are not billed as Data Transfer and the call is not billed as a sub-request.",
          },
          bad,
          good,
        });
      }

      default:
        return new Response(
          "demo-router\n\n" +
            "GET /                                 compare both proxies\n" +
            "GET /bad                              anti-pattern only\n" +
            "GET /good                             recommended only\n" +
            "GET /bad-next                         anti-pattern, forced backend=next\n" +
            "GET /good-next                        recommended, forced backend=next\n" +
            "Query params (passed through to both):\n" +
            "  ?host=<tenant-hostname>             override outside host (default: inbound URL hostname)\n" +
            "  ?path=<path>                        downstream route (default: /api/catalog)\n" +
            "  ?size=<KB>                          payload size for /api/catalog (default: 64)\n" +
            "  ?backend=plain|next                 which callee to hit (default: plain)\n",
          { status: 404, headers: { "content-type": "text/plain" } },
        );
    }
  },
} satisfies ExportedHandler<Env>;

function jsonOf(result: ProxyResult): Response {
  return Response.json(result, { status: result.status });
}
