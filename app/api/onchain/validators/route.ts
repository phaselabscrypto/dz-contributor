import { NextResponse } from "next/server";
import { ONCHAIN_ENABLED } from "@/lib/onchain/program-ids";
import { fetchOnchainValidatorPayouts } from "@/lib/onchain/validators";
import { reportError } from "@/lib/observability";

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
    // Full detail server-side only — the message can carry RPC config
    // guidance / hostnames that must not reach the public client.
    reportError(err, { source: "api/onchain/validators" });
    return NextResponse.json(
      {
        error: "On-chain validator payout fetch failed",
        epochs: [],
        source: "stub",
      },
      { status: 502 },
    );
  }
}
