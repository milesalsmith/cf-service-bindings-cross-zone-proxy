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
