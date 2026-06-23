import { NextResponse } from "next/server";
import { ONCHAIN_ENABLED } from "@/lib/onchain/program-ids";
import { fetchOnchainValidatorPayouts } from "@/lib/onchain/validators";

/**
 * GET /api/onchain/validators
 *
 * Per-epoch validator payout history (SOL) read from the DZ rewards
 * program. 503 with stable shape until ONCHAIN_ENABLED + the rewards
 * program IDL are configured.
 */
export async function GET() {
  if (!ONCHAIN_ENABLED) {
    return NextResponse.json(
      {
        error: "On-chain validator payout reader disabled",
        reason:
          "Set DZ_REWARDS_PROGRAM_ID + ONCHAIN_ENABLED=1 once the Foundation publishes the IDL.",
        epochs: [],
        source: "stub",
      },
      { status: 503 },
    );
  }

  try {
    const history = await fetchOnchainValidatorPayouts();
    return NextResponse.json(history);
  } catch (err) {
    return NextResponse.json(
      {
        error: `On-chain validator payout fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        epochs: [],
        source: "stub",
      },
      { status: 502 },
    );
  }
}
