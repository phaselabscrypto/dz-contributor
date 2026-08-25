#!/usr/bin/env node
/**
 * Snapshot-stability test for `lib/hooks/use-local-storage.ts`.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`, so `getSnapshot`
 * must hand React a primitive. Returning a freshly parsed object re-renders
 * without end and throws minified React error #185. These assertions pin the
 * property React actually depends on: `readStoredRaw` returns the raw string,
 * and the parse happens downstream in `parseStored`.
 *
 * Also covers the stored-value guard in `lib/utils/sort-state.ts`, which keeps
 * a stale or hand-edited entry from reaching a table comparator.
 *
 * Pure input construction — no storage, no network, no browser, safe anywhere.
 *
 * Usage:
 *   npx tsx scripts/test-local-storage-snapshot.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { readStoredRaw, parseStored } from "../lib/hooks/use-local-storage";
import { makeSortStateValidator } from "../lib/utils/sort-state";

type FakeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function makeFakeStorage(throwOnGet = false): FakeStorage {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      if (throwOnGet) throw new Error("storage blocked");
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

let storage = makeFakeStorage();
// Getter, not a fixed value, so a case can swap the backing store mid-run.
globalThis.window = {
  get localStorage() {
    return storage;
  },
} as unknown as Window & typeof globalThis;

// Copied verbatim from node_modules/react-dom/cjs/react-dom-client.production.js
// so the assertions run against React's real comparison, not a paraphrase.
function checkIfSnapshotChanged(inst: {
  value: unknown;
  getSnapshot: () => unknown;
}): boolean {
  const latestGetSnapshot = inst.getSnapshot;
  const prev = inst.value;
  try {
    const nextValue = latestGetSnapshot();
    return !Object.is(prev, nextValue);
  } catch {
    return true;
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

type SortKey = "code" | "bw" | "lat";
const SORT_KEYS: Record<SortKey, true> = { code: true, bw: true, lat: true };
const DEFAULT_SORT = { key: "code" as SortKey, dir: "asc" as const };
const validateSort = makeSortStateValidator(SORT_KEYS);

const STORED = '{"key":"bw","dir":"desc"}';

// 1. readStoredRaw never hands back an object.
console.log("\n1. readStoredRaw returns a primitive");
for (const [label, stored] of [
  ["absent", null],
  ["valid json", STORED],
  ["corrupt json", "not json"],
  ["empty string", ""],
  ["literal null", "null"],
] as const) {
  const key = `t1.${label}`;
  if (stored !== null) storage.setItem(key, stored);
  const raw = readStoredRaw(key);
  check(
    `${label} -> ${raw === null ? "null" : typeof raw}`,
    raw === null || typeof raw === "string",
    `got ${typeof raw}`,
  );
}

// 2. The #185 guard: identical storage yields an identical snapshot.
console.log("\n2. repeated reads are Object.is-equal");
{
  const key = "t2.stable";
  storage.setItem(key, STORED);
  const first = readStoredRaw(key);
  let stable = true;
  for (let i = 0; i < 100; i++) {
    if (!Object.is(first, readStoredRaw(key))) stable = false;
  }
  check("stored value stable across 100 reads", stable);

  const absent = readStoredRaw("t2.missing");
  check(
    "absent key stable across 100 reads",
    Array.from({ length: 100 }).every(() =>
      Object.is(absent, readStoredRaw("t2.missing")),
    ),
  );
}

// 3. A blocked storage read degrades instead of throwing.
console.log("\n3. blocked storage");
{
  const healthy = storage;
  storage = makeFakeStorage(true);
  let threw = false;
  let raw: string | null = "unset";
  try {
    raw = readStoredRaw("t3.blocked");
  } catch {
    threw = true;
  }
  check("getItem throwing does not propagate", !threw);
  check("getItem throwing reads as absent", raw === null);
  storage = healthy;
}

// 4. parseStored fallback behavior.
console.log("\n4. parseStored");
{
  const fb = DEFAULT_SORT;
  check("absent -> fallback", parseStored(null, fb) === fb);
  check("corrupt json -> fallback", parseStored("not json", fb) === fb);
  check("empty string -> fallback", parseStored("", fb) === fb);
  check("literal null -> fallback", parseStored("null", fb) === fb);
  check(
    "valid json -> parsed",
    JSON.stringify(parseStored(STORED, fb)) === STORED,
  );
  check(
    "validator rejects stale key -> fallback",
    parseStored('{"key":"gone","dir":"asc"}', fb, validateSort) === fb,
  );
  check(
    "validator rejects bad dir -> fallback",
    parseStored('{"key":"bw","dir":"sideways"}', fb, validateSort) === fb,
  );
  check(
    "validator accepts a good pair",
    parseStored(STORED, fb, validateSort).key === "bw",
  );
}

// 5. The stored-value guard itself.
console.log("\n5. makeSortStateValidator");
{
  check("good pair accepted", validateSort({ key: "lat", dir: "desc" }) !== null);
  check("null rejected", validateSort(null) === null);
  check("non-object rejected", validateSort("bw") === null);
  check("array rejected", validateSort(["bw", "asc"]) === null);
  check("missing key rejected", validateSort({ dir: "asc" }) === null);
  check("missing dir rejected", validateSort({ key: "bw" }) === null);
  check(
    "unknown key rejected",
    validateSort({ key: "nope", dir: "asc" }) === null,
  );
  check(
    "bad dir rejected",
    validateSort({ key: "bw", dir: "sideways" }) === null,
  );
  check(
    "non-string key rejected",
    validateSort({ key: 7, dir: "asc" }) === null,
  );
}

// 6. React's own consistency check cannot fire on an unchanged store.
console.log("\n6. React checkIfSnapshotChanged");
for (const [label, stored] of [
  ["absent", null],
  ["valid json", STORED],
  ["corrupt json", "not json"],
  ["empty string", ""],
  ["literal null", "null"],
] as const) {
  const key = `t6.${label}`;
  if (stored !== null) storage.setItem(key, stored);
  const inst = {
    value: readStoredRaw(key),
    getSnapshot: () => readStoredRaw(key),
  };
  check(`${label} -> no forced re-render`, !checkIfSnapshotChanged(inst));
}
{
  // Positive control: a real write must still be detected, or the hook would
  // silently stop tracking storage.
  const key = "t6.detects-change";
  storage.setItem(key, STORED);
  const inst = {
    value: readStoredRaw(key),
    getSnapshot: () => readStoredRaw(key),
  };
  storage.setItem(key, '{"key":"lat","dir":"asc"}');
  check("a real write is still detected", checkIfSnapshotChanged(inst));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
