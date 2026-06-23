import { NextResponse } from "next/server";

/**
 * Web vitals sink.
 *
 * Today this is a no-op — accepts the payload, drops it on the floor in
 * production, logs in dev so we can sanity-check the reporter is wired.
 *
 * When Phase wires a real metrics backend (Datadog, Vercel Analytics
 * custom events, etc.), forward the payload here.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "production") {
    try {
      const body = await req.json();
      // eslint-disable-next-line no-console
      console.log("[vitals]", body);
    } catch {
      // ignore malformed bodies in dev
    }
  }
  // Always 204 — never make the page wait on this.
  return new NextResponse(null, { status: 204 });
}
