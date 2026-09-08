/**
 * Contract test for `GET /api/shapley/tracking` and the pure pivot behind it,
 * with the Rust service and the snapshot bucket stubbed out.
 *
 * The route is cache-only: it probes the latest N epochs in parallel, renders
 * the ones the cron has published, and names the rest in `missingEpochs`.
 *
 * Usage:
 *   node --import tsx scripts/test-tracking-route.ts
 */
import assert from "node:assert/strict";

import type { EpochBaseline, ShapleyTracking } from "@/lib/types/baseline";

const METHOD = "lp-multi-commodity-flow-rs";

/** Population stdev of [0.5, 0.6, 0.7] and of [0.5, 0.4, 0.3]. */
const EXPECTED_STDEV = 0.0816496580927726;

function fixture(epoch: number, aShare: number): EpochBaseline {
  return {
    epoch,
    tag: `baseline:epoch-${epoch}`,
    method: METHOD,
    operatorCount: 2,
    values: {
      a: { value: aShare * 10, share: aShare },
      b: { value: (1 - aShare) * 10, share: 1 - aShare },
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
  };
}

async function main(): Promise<void> {
  process.env.SHAPLEY_SERVICE_URL = "https://service.test";
  process.env.SHAPLEY_API_TOKEN = "test-compute";

  const { S3_SNAPSHOT_URL_TEMPLATE } = await import("@/lib/constants/config");
  const { LATEST_BASELINE_CACHE_CONTROL } = await import(
    "@/lib/utils/baseline-probe"
  );
  const { pivotTracking } = await import("@/lib/utils/tracking-series");
  const { baselineTag } = await import("@/lib/utils/sweep-tag");
  const { GET: tracking } = await import("@/app/api/shapley/tracking/route");

  console.log("pivot:");
  const pivoted = pivotTracking([
    fixture(209, 0.5),
    fixture(210, 0.6),
    fixture(211, 0.7),
  ]);
  assert.equal(pivoted.method, METHOD);
  assert.equal(pivoted.operators[0].operator, "a");
  assert.equal(pivoted.operators[0].series.length, 3);
  assert.deepEqual(
    pivoted.operators[0].series.map((point) => point.epoch),
    [209, 210, 211],
  );
  for (const operator of pivoted.operators) {
    const first = operator.series[0].share;
    const last = operator.series[operator.series.length - 1].share;
    assert.ok(Math.abs(operator.delta - (last - first)) < 1e-12);
    assert.equal(operator.latestShare, last);
    assert.ok(Math.abs(operator.stdev - EXPECTED_STDEV) < 1e-12);
  }
  console.log("  ok   sorted by latest share, delta and stdev per operator");

  const [snapshotPrefix, snapshotSuffix] =
    S3_SNAPSHOT_URL_TEMPLATE.split("{N}");
  const snapshotEpoch = (url: string): number | null => {
    if (!url.startsWith(snapshotPrefix) || !url.endsWith(snapshotSuffix)) {
      return null;
    }
    const epoch = Number(
      url.slice(snapshotPrefix.length, url.length - snapshotSuffix.length),
    );
    return Number.isInteger(epoch) ? epoch : null;
  };
  const epochOfTag = new Map<string, number>();
  for (let epoch = 181; epoch <= 211; epoch += 1) {
    epochOfTag.set(baselineTag(epoch), epoch);
  }

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let cachedEpochs = new Set<number>([209, 210, 211]);
  let failingEpoch: number | null = null;
  let probes: number[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const snapshot = snapshotEpoch(url);
    if (snapshot !== null) {
      return new Response("", { status: snapshot <= 211 ? 200 : 404 });
    }
    assert.ok(
      url.startsWith("https://service.test/shapley/baseline?"),
      `unexpected request ${url}`,
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-compute",
    );
    const tag = new URL(url).searchParams.get("tag") ?? "";
    const epoch = epochOfTag.get(tag);
    assert.ok(epoch !== undefined, `unknown tag ${tag}`);
    probes.push(epoch);
    if (epoch === failingEpoch) {
      return new Response("boom service.test", { status: 500 });
    }
    if (!cachedEpochs.has(epoch)) {
      return Response.json({ status: "not-cached", tag }, { status: 404 });
    }
    const share = 0.5 + 0.01 * (epoch - 204);
    return Response.json({
      method: METHOD,
      operator_count: 2,
      values: {
        a: { value: share * 10, share },
        b: { value: (1 - share) * 10, share: 1 - share },
      },
      tag,
      variant: "foundation",
      input_hash: "0123456789abcdef",
    });
  }) as typeof fetch;

  const call = async (query: string): Promise<Response> => {
    probes = [];
    errors = [];
    return tracking(new Request(`http://localhost/api/shapley/tracking${query}`));
  };

  try {
    console.log("route:");

    let res = await call("?count=8");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("cache-control"),
      LATEST_BASELINE_CACHE_CONTROL,
    );
    const body = (await res.json()) as ShapleyTracking;
    assert.deepEqual(body.epochs, [209, 210, 211]);
    assert.deepEqual(body.missingEpochs, [204, 205, 206, 207, 208]);
    assert.equal(body.method, METHOD);
    assert.equal(body.operators[0].series.length, 3);
    assert.equal(probes.length, 8);
    console.log("  ok   three cached of eight → 200 listing the misses");

    cachedEpochs = new Set<number>([211]);
    res = await call("?count=8");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      status: "not-cached",
      epochs: [211],
      missingEpochs: [204, 205, 206, 207, 208, 209, 210],
    });
    console.log("  ok   one cached of eight → 404 not-cached");

    cachedEpochs = new Set<number>([209, 210, 211]);
    failingEpoch = 207;
    res = await call("?count=8");
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      error: "Service temporarily unavailable",
    });
    assert.ok(!text.includes("service.test"), "no upstream host in the body");
    assert.equal(
      errors.filter((line) => line.includes("[obs:error]")).length,
      1,
    );
    failingEpoch = null;
    console.log("  ok   one failing probe → generic 502, one reported error");

    await call("?count=1");
    assert.equal(probes.length, 2);
    await call("?count=99");
    assert.equal(probes.length, 20);
    await call("?count=abc");
    assert.equal(probes.length, 8);
    console.log("  ok   count clamps to [2, 20] and defaults to 8");

    console.log("tracking route: passed");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
