// Landing page exists only so Next.js does not 404 the root. The demo
// exercises /api/catalog and /api/whoami via the proxy and demo-router;
// this page is incidental.

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32, lineHeight: 1.5 }}>
      <h1>app-region-1-next</h1>
      <p>
        This is the Next.js + OpenNext companion to <code>app-region-1</code>.
        See <a href="/api/catalog">/api/catalog</a> and{" "}
        <a href="/api/whoami">/api/whoami</a>.
      </p>
    </main>
  );
}
