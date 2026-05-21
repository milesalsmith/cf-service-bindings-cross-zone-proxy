// Vercel-portable api-client adapter.
//
// Identical contract to workers/app-region-1/src/api-client.ts: app code
// asks for `getApiClient(env)` and never references either transport. The
// only Next.js-flavored difference is that this file is imported from
// route handlers, which obtain `env` via `getCloudflareContext()` rather
// than a Worker handler argument.
//
// On Workers (OpenNext): bind `API` in wrangler.jsonc, code uses the
// Service Binding. Bytes do not leave the runtime; not billed as Data
// Transfer; not billed as a sub-request.
//
// On Vercel/Node: set `API_BASE_URL` env var. Code falls back to plain
// fetch over HTTPS.

export interface ApiClient {
  get(path: string): Promise<Response>;
}

export interface ApiClientEnv {
  API?: Fetcher;
  API_BASE_URL?: string;
}

export function getApiClient(env: ApiClientEnv): ApiClient {
  if (env.API) {
    return {
      get: (path) => env.API!.fetch(`https://internal${path}`),
    };
  }

  if (env.API_BASE_URL) {
    return {
      get: (path) => fetch(`${env.API_BASE_URL}${path}`),
    };
  }

  throw new Error(
    "No API transport configured. Set env.API (Service Binding, Workers) " +
      "or env.API_BASE_URL (HTTPS, Vercel/Node).",
  );
}
