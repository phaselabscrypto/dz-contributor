import { NextResponse } from "next/server";
import { getContributorDirectory } from "@/lib/onchain/contributor-directory";
import { reportError } from "@/lib/observability";

/**
 * GET /api/onchain/contributors
 *
 * Returns the full set of Contributor accounts decoded from the DZ
 * serviceability program on the DZ ledger. Includes both lookup
 * directions (owner → code, code → owner) so callers don't have to
 * iterate.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const directory = await getContributorDirectory();
    return NextResponse.json(directory, {
      headers: {
        "Cache-Control":
          "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    // Full detail server-side only — the message can carry RPC config
    // guidance / hostnames that must not reach the public client.
    reportError(err, { source: "api/onchain/contributors" });
    return NextResponse.json(
      {
        error: "Failed to fetch contributor directory",
        contributors: [],
        ownerToCode: {},
        codeToOwner: {},
        fetchedAt: new Date().toISOString(),
      },
      { status: 502 },
    );
  }
}
