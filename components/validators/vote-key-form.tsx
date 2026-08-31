"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { validatePubkey } from "@/lib/utils/pubkey";

/**
 * Vote-account input.
 *
 * A form with an explicit submit, not a live-search box. Every submission
 * costs an RPC call, and debouncing a 44-character paste still fires several.
 * Submit also matches what the page now does: it resolves an identifier
 * against the chain rather than filtering a local array.
 *
 * Exactly one `input[type="text"]` here, permanently. The `/` shortcut in
 * `keyboard-shortcuts.tsx` focuses the first text input in DOM order, so a
 * second one makes it ambiguous with no error. Any future numeric field must
 * be `type="number"`, which that selector skips.
 */
export function VoteKeyForm({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (pubkey: string | null) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const trimmed = draft.trim();
  const parsed = validatePubkey(trimmed);
  const showError = trimmed.length > 0 && !parsed.ok;

  // Specific hints, because pasted keys fail on length (truncation) while
  // typed keys fail on character (0/O confusion), and the fix differs.
  const hint = !parsed.ok
    ? parsed.reason === "excluded-char"
      ? "Base58 does not use the characters 0, O, I, or l. Check for a typo."
      : parsed.reason === "too-short" || parsed.reason === "too-long"
        ? "That looks like a pubkey but it is the wrong length. A vote account is 43 or 44 characters. Check for a missing or extra character."
        : "That is not a valid pubkey. A Solana vote account is 32 bytes encoded as base58."
    : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.ok) onSubmit(parsed.pubkey);
      }}
      className="space-y-2"
    >
      <label
        htmlFor="vote-account"
        className="block text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono"
      >
        Vote account
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-cream-30" />
          <input
            id="vote-account"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Vote account pubkey"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-invalid={showError}
            aria-describedby="vote-account-hint"
            className="w-full bg-cream-5 border border-cream-8 pl-10 pr-4 py-2.5 text-sm font-mono text-cream placeholder:text-cream-30 focus:outline-none focus:border-cream-20 transition-colors"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!parsed.ok}
            className="px-4 py-2.5 text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 enabled:hover:border-cream-30 enabled:hover:bg-cream-8 disabled:opacity-40 transition-colors"
          >
            Estimate
          </button>
          {draft.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                onSubmit(null);
              }}
              className="px-4 py-2.5 text-xs font-mono uppercase tracking-[0.12em] border border-cream-15 hover:border-cream-30 hover:bg-cream-8 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {showError ? (
        <p
          id="vote-account-hint"
          role="alert"
          className="bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300"
        >
          {hint}
        </p>
      ) : (
        <p id="vote-account-hint" className="text-xs text-cream-30 font-mono">
          43 or 44 base58 characters. Node identities and stake accounts are not
          accepted.
        </p>
      )}
    </form>
  );
}
