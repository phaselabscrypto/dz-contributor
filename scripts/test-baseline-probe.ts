/**
 * Contract test for the cache-only baseline routes, with the Rust service and
 * the snapshot bucket stubbed out.
 *
 * Covers `GET /api/shapley/baseline` and `GET /api/shapley?epoch=N`: a hit, a
 * miss, an upstream failure (which must not leak the upstream host), a service
 * that predates the probe route, and the client-side timeout.
 *
 * Usage:
 *   node --import tsx scripts/test-baseline-probe.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import type { EpochBaseline } from "@/lib/types/baseline";

type ProbeMode = "hit" | "miss" | "upstream-500" | "legacy-404";

const HIT_BODY = {
  method: "lp-multi-commodity-flow-rs",
  operator_count: 2,
  values: {
    a: { value: 6, share: 0.6 },
    b: { value: 4, share: 0.4 },
  },
  input_hash: "0123456789abcdef",
};

// Runs in its own process because discovery caches its result for 5 minutes.
// The HEAD settles only when its signal aborts, so this checks the plumbing.
async function runDiscoveryHangScenario(): Promise<void> {
  process.env.SHAPLEY_SERVICE_URL = "https://service.test";
  process.env.SHAPLEY_API_TOKEN = "test-compute";
  const { S3_SNAPSHOT_URL_TEMPLATE } = await import("@/lib/constants/config");
  const { GET: latestBaseline } = await import(
    "@/app/api/shapley/baseline/route"
  );
  const [snapshotPrefix, snapshotSuffix] =
    S3_SNAPSHOT_URL_TEMPLATE.split("{N}");

  let sawAbortSignal = false;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (!url.startsWith(snapshotPrefix) || !url.endsWith(snapshotSuffix)) {
      throw new Error(`unexpected non-discovery request ${url}`);
    }
    sawAbortSignal = init?.signal instanceof AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;

  // The per-HEAD timeout inside epoch-discovery.ts uses a real (unref'd)
  // timer; keep the process alive long enough for it to fire.
  const keepAlive = setTimeout(() => {}, 8_000);
  try {
    const res = await latestBaseline(
      new Request("http://localhost/api/shapley/baseline"),
    );
    assert.equal(res.status, 502);
    assert.ok(sawAbortSignal, "the discovery HEAD carries an AbortSignal");
  } finally {
    clearTimeout(keepAlive);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--discovery-hang")) {
    await runDiscoveryHangScenario();
    return;
  }

  process.env.SHAPLEY_SERVICE_URL = "https://service.test";
  process.env.SHAPLEY_API_TOKEN = "test-compute";

  const { S3_SNAPSHOT_URL_TEMPLATE } = await import("@/lib/constants/config");
  const {
    EPOCH_BASELINE_CACHE_CONTROL,
    LATEST_BASELINE_CACHE_CONTROL,
    probeEpochBaseline,
  } = await import("@/lib/utils/baseline-probe");
  const { BaselineServiceError } = await import("@/lib/utils/shapley-remote");
  const { baselineTag } = await import("@/lib/utils/sweep-tag");
  const { GET: latestBaseline } = await import(
    "@/app/api/shapley/baseline/route"
  );
  const { GET: epochBaseline } = await import("@/app/api/shapley/route");

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

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalInfo = console.info;
  let errors: string[] = [];
  let events: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]) => {
    events.push(args.map(String).join(" "));
  };
  const reset = (): void => {
    errors = [];
    events = [];
  };

  let mode: ProbeMode = "hit";
  const tag211 = baselineTag(211);

  const primaryFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const epoch = snapshotEpoch(url);
    if (epoch !== null) {
      assert.equal(method, "HEAD");
      return new Response("", { status: epoch <= 211 ? 200 : 404 });
    }
    assert.ok(
      url.startsWith("https://service.test/shapley/baseline?"),
      `unexpected request ${method} ${url}`,
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-compute",
    );
    const tag = new URL(url).searchParams.get("tag");
    assert.ok(tag, "probe carries a tag");
    if (mode === "hit") return Response.json({ ...HIT_BODY, tag });
    if (mode === "miss") {
      return Response.json({ status: "not-cached", tag }, { status: 404 });
    }
    if (mode === "legacy-404") {
      return new Response("not found", { status: 404 });
    }
    return new Response("boom service.test", { status: 500 });
  }) as typeof fetch;
  globalThis.fetch = primaryFetch;

  try {
    console.log("latest baseline:");

    mode = "hit";
    reset();
    let res = await latestBaseline(
      new Request("http://localhost/api/shapley/baseline"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("cache-control"),
      LATEST_BASELINE_CACHE_CONTROL,
    );
    let body = (await res.json()) as EpochBaseline;
    assert.equal(body.epoch, 211);
    assert.equal(body.tag, tag211);
    assert.equal(body.method, HIT_BODY.method);
    assert.equal(body.operatorCount, 2);
    assert.equal(body.values.a.share, 0.6);
    assert.equal(typeof body.fetchedAt, "string");
    console.log("  ok   hit → 200 with the cached shape");

    mode = "miss";
    reset();
    res = await latestBaseline(
      new Request("http://localhost/api/shapley/baseline"),
    );
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      status: "not-cached",
      epoch: 211,
      tag: tag211,
    });
    assert.equal(
      events.filter((line) => line.includes("[obs:event] baseline-not-cached"))
        .length,
      1,
    );
    console.log("  ok   miss → 404 not-cached, no-store, one event");

    mode = "upstream-500";
    reset();
    res = await latestBaseline(
      new Request("http://localhost/api/shapley/baseline"),
    );
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
    console.log("  ok   upstream 500 → generic 502, one reported error");

    mode = "legacy-404";
    reset();
    await assert.rejects(
      probeEpochBaseline(211),
      (error: unknown) =>
        error instanceof BaselineServiceError && error.status === 404,
    );
    res = await latestBaseline(
      new Request("http://localhost/api/shapley/baseline"),
    );
    assert.equal(res.status, 502);
    console.log("  ok   404 without a not-cached body → 502");

    console.log("epoch baseline:");

    mode = "hit";
    reset();
    res = await epochBaseline(
      new Request("http://localhost/api/shapley?epoch=latest"),
    );
    assert.equal(res.status, 400);
    res = await epochBaseline(
      new Request("http://localhost/api/shapley?epoch=47"),
    );
    assert.equal(res.status, 400);
    res = await epochBaseline(new Request("http://localhost/api/shapley"));
    assert.equal(res.status, 400);
    console.log("  ok   non-numeric, below-floor and absent epochs → 400");

    res = await epochBaseline(
      new Request("http://localhost/api/shapley?epoch=211"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("cache-control"),
      EPOCH_BASELINE_CACHE_CONTROL,
    );
    body = (await res.json()) as EpochBaseline;
    assert.equal(body.epoch, 211);
    assert.equal(body.tag, tag211);

    mode = "miss";
    res = await epochBaseline(
      new Request("http://localhost/api/shapley?epoch=211"),
    );
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), {
      status: "not-cached",
      epoch: 211,
      tag: tag211,
    });
    console.log("  ok   epoch hit → 200 cached long, miss → 404 no-store");

    // AbortSignal.timeout timers are unref'd, so without a live handle Node
    // would exit before the abort fires.
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener(
              "abort",
              () => stream.error(init.signal?.reason),
              { once: true },
            );
          },
        }),
      )) as typeof fetch;
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(
        probeEpochBaseline(211, { timeoutMs: 10 }),
        (error: unknown) =>
          error instanceof BaselineServiceError && error.timedOut,
      );
    } finally {
      clearTimeout(keepAlive);
    }
    console.log("  ok   probe timeout → typed BaselineServiceError");

    // A fresh process: the 5-minute discovery cache would otherwise mask the
    // deadline plumbing behind the epoch the earlier scenarios already warmed.
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/test-baseline-probe.ts",
      "--discovery-hang",
    ]);
    console.log(
      "  ok   discovery HEAD never resolving → 502 (deadline plumbing)",
    );

    console.log("baseline probe: passed");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.info = originalInfo;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
