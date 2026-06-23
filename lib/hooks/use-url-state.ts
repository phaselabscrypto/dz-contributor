"use client";

/**
 * URL-state hook built on nuqs. Re-exports the most commonly used parsers
 * so feature code imports a single module.
 */
export {
  useQueryState,
  useQueryStates,
  parseAsString,
  parseAsInteger,
  parseAsFloat,
  parseAsBoolean,
  parseAsArrayOf,
  parseAsStringEnum,
  parseAsStringLiteral,
} from "nuqs";

import { useQueryState, parseAsString } from "nuqs";

/**
 * Convenience wrapper for a single string URL param with an optional default.
 * Returns a tuple matching `useState`'s shape for ergonomics.
 */
export function useUrlState(
  key: string,
  defaultValue = "",
): [string, (next: string | null) => void] {
  const [value, setValue] = useQueryState(
    key,
    parseAsString.withDefault(defaultValue),
  );
  return [value, setValue];
}
