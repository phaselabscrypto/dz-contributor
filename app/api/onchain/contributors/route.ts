import { NextResponse } from "next/server";
import { getContributorDirectory } from "@/lib/onchain/contributor-directory";

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
    return NextResponse.json(
      {
        error: `Failed to fetch contributor directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
        contributors: [],
        ownerToCode: {},
        codeToOwner: {},
        fetchedAt: new Date().toISOString(),
      },
      { status: 502 },
    );
  }
}
