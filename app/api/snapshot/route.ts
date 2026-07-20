import { NextRequest, NextResponse } from "next/server";
import { getSnapshotUrl } from "@/lib/constants/config";
import { reportError } from "@/lib/observability";
import { LruCache } from "@/lib/utils/lru-cache";

// Snapshots are ~5MB JSON blobs. Capped at 8 entries so worst-case memory
// stays around 40MB — well inside Vercel's 512MB Lambda budget.
const snapshotCache = new LruCache<number, unknown>({
  ttlMs: 5 * 60 * 1000,
  maxSize: 8,
});

// Snapshots for completed epochs are immutable on S3, so we can
// cache aggressively at every layer.
const cacheControl =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const epochStr = searchParams.get("epoch");

  if (!epochStr) {
    return NextResponse.json(
      { error: "epoch parameter required" },
      { status: 400 }
    );
  }

  const epoch = parseInt(epochStr, 10);
  if (isNaN(epoch)) {
    return NextResponse.json(
      { error: "epoch must be a number" },
      { status: 400 }
    );
  }

  const cached = snapshotCache.get(epoch);
  if (cached !== undefined) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": cacheControl },
    });
  }

  try {
    const url = getSnapshotUrl(epoch);
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json(
          { error: `Epoch ${epoch} not found` },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: `Failed to fetch snapshot: ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    snapshotCache.set(epoch, data);
    return NextResponse.json(data, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (err) {
    reportError(err, { source: "api/snapshot", extras: { epoch } });
    // Generic to the client — ${err} can carry upstream fetch detail.
    return NextResponse.json(
      { error: "Failed to fetch snapshot" },
      { status: 500 }
    );
  }
}
