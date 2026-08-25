/** A table sort persisted to storage. */
export type SortState<K extends string> = { key: K; dir: "asc" | "desc" };

/**
 * Build a validator that accepts only a sort whose column is a member of
 * `keys`. Annotate the caller's table as `Record<SortKey, true>` so a renamed
 * or missing column is a compile error.
 */
export function makeSortStateValidator<K extends string>(
  keys: Readonly<Record<K, true>>,
): (parsed: unknown) => SortState<K> | null {
  const isSortKey = (v: string): v is K => v in keys;

  return (parsed: unknown): SortState<K> | null => {
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("key" in parsed) || !("dir" in parsed)) return null;
    const { key, dir } = parsed;
    if (typeof key !== "string" || !isSortKey(key)) return null;
    if (dir !== "asc" && dir !== "desc") return null;
    return { key, dir };
  };
}
