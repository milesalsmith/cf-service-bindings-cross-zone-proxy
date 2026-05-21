// Minimal root layout. No UI is rendered for this demo; only API routes
// are exercised. A real Next.js app would put providers, fonts, and the
// global stylesheet here.

export const metadata = {
  title: "app-region-1-next",
  description:
    "OpenNext-on-Cloudflare worker that mirrors app-region-1. Used as a Service Binding target by proxy-production-good.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
