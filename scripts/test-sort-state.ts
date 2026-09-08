import assert from "node:assert/strict";
import { nextSortState, type SortState } from "../lib/utils/sort-state";

type Key = "name" | "live" | "alltime" | "devices";

// Stored key survives a page with no live column, so the effective key
// (post-fallback) can differ from the stored key. Clicking the effective
// key must sort on it, not on the stale stored key.
const stored: SortState<Key> = { key: "live", dir: "desc" };
assert.deepEqual(nextSortState(stored, "alltime", "alltime", ["name"]), {
  key: "alltime",
  dir: "asc",
});

// Clicking the already-effective column toggles its direction.
assert.deepEqual(nextSortState(stored, "live", "live", ["name"]), {
  key: "live",
  dir: "asc",
});
assert.deepEqual(
  nextSortState({ key: "live", dir: "asc" }, "live", "live", ["name"]),
  { key: "live", dir: "desc" },
);

// Clicking a new column starts asc when it's in ascFirst, desc otherwise.
assert.deepEqual(
  nextSortState({ key: "alltime", dir: "desc" }, "name", "alltime", ["name"]),
  { key: "name", dir: "asc" },
);
assert.deepEqual(
  nextSortState({ key: "name", dir: "asc" }, "devices", "name", ["name"]),
  { key: "devices", dir: "desc" },
);

console.log("sort state: passed");
