import assert from "node:assert/strict";
import { scheduleDiffRepairs } from "@/lib/utils/diff-repair-schedule";

assert.deepEqual(scheduleDiffRepairs([181, 182, 183, 211], 211, 3, 0), { selected: [211, 183, 181], deferred: [182] });
assert.deepEqual(scheduleDiffRepairs([181, 182, 183, 211], 211, 3, 1), { selected: [211, 183, 182], deferred: [181] });
assert.deepEqual(scheduleDiffRepairs([], 211, 3, 0), { selected: [], deferred: [] });
assert.deepEqual(scheduleDiffRepairs([211, 211, 210], 211, 0, 0), { selected: [], deferred: [210, 211] });
const backlog = Array.from({ length: 31 }, (_, index) => 181 + index);
const visited = new Set<number>();
for (let slot = 0; slot < backlog.length; slot++) {
  const { selected, deferred } = scheduleDiffRepairs(backlog, 211, 3, slot);
  assert.equal(selected[0], 211);
  assert.equal(selected.length, 3);
  assert.equal(new Set([...selected, ...deferred]).size, backlog.length);
  selected.forEach(epoch => visited.add(epoch));
}
assert.deepEqual([...visited].sort((a, b) => a - b), backlog);
assert.throws(() => scheduleDiffRepairs([NaN], 211, 3, 0));
assert.throws(() => scheduleDiffRepairs([212], 211, 3, 0));
console.log("diff repair scheduling: passed");
