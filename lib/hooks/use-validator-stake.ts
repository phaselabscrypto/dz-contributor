"use client";

import useSWR from "swr";
import type { ValidatorStakeResponse } from "@/lib/types/validator-stake";

/**
 * Error carrying the HTTP status.
 *
 * Every other hook in this directory flattens the status into a message
 * string (`API error: 404`), which is fine when the only handling is a retry
 * button. Here the status decides what the page says: 404 is "no vote account
 * found", 502 is "the RPC did not respond", 429 is "wait a minute". Those need
 * different copy, so the code has to survive structurally.
 */
export class ValidatorStakeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ValidatorStakeError";
    this.status = status;
  }
}

const fetcher = async (url: string): Promise<ValidatorStakeResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    // The route's bodies are already generic, so passing the message through
    // leaks nothing. It falls back to the status when the body is unreadable.
    let message = `Stake lookup failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON body, e.g. a platform error page. Keep the fallback.
    }
    throw new ValidatorStakeError(res.status, message);
  }
  return res.json();
};

/**
 * Activated stake for one vote account.
 *
 * @param pubkey - a base58 pubkey, or null to make no request. Validate on the
 *   client first so a typo never costs an RPC call.
 */
export function useValidatorStake(pubkey: string | null) {
  return useSWR<ValidatorStakeResponse, ValidatorStakeError>(
    pubkey !== null ? `/api/validators/stake?pubkey=${pubkey}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
      // A 404 or a 400 is deterministic. Retrying it loops against a paid RPC
      // for an answer that cannot change.
      shouldRetryOnError: false,
    },
  );
}
