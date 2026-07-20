import { NextResponse } from "next/server";
import { fetchLiveTopology } from "@/lib/utils/live-topology-fetch";
import { reportError } from "@/lib/observability";

export const revalidate = 60;

export async function GET() {
  try {
    const data = await fetchLiveTopology();
    return NextResponse.json(data);
  } catch (err) {
    reportError(err, { source: "api/live/topology" });
    // Generic to the client — the message can name the upstream host.
    return NextResponse.json(
      { error: "Topology fetch failed" },
      { status: 502 },
    );
  }
}
