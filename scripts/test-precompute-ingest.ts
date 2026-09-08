import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { RawSnapshot } from "@/lib/types/snapshot";

function snapshot(epoch: number): RawSnapshot {
  return {
    dz_epoch: epoch,
    solana_epoch: 1,
    fetch_data: {
      start_us: 1,
      end_us: 2,
      metro_prices: { test: 1 },
      dz_serviceability: {
        contributors: {},
        devices: {},
        links: {},
        locations: {},
        exchanges: {},
        users: {},
      },
      dz_telemetry: { device_latency_samples: [] },
      dz_internet: { internet_latency_samples: [] },
    },
    leader_schedule: { solana_epoch: 1, schedule_map: {} },
    metadata: {
      created_at: "",
      network: "test",
      exchanges_count: 0,
      locations_count: 0,
      devices_count: 0,
      internet_samples_count: 0,
      device_samples_count: 0,
    },
  };
}

async function main(): Promise<void> {
  process.env.SHAPLEY_SERVICE_URL = "https://service.test";
  process.env.SHAPLEY_API_TOKEN = "test-compute";
  if (process.argv.includes("--missing-ingest")) {
    delete process.env.SHAPLEY_INGEST_TOKEN;
    const { startLinkEstimateSweep } = await import(
      "@/lib/utils/shapley-remote"
    );
    const { buildCanonicalShapleyInput } = await import(
      "@/lib/utils/canonical-input-builder"
    );
    globalThis.fetch = async () => {
      throw new Error("must reject before fetch");
    };
    await assert.rejects(
      startLinkEstimateSweep(
        buildCanonicalShapleyInput(snapshot(211)).input,
        "test",
      ),
      /SHAPLEY_INGEST_TOKEN not configured/,
    );
    return;
  }
  if (process.argv.includes("--missing-service")) {
    delete process.env.SHAPLEY_SERVICE_URL;
    delete process.env.PYTHON_SHAPLEY_URL;
    const { runPrecomputeIngest } = await import(
      "@/lib/utils/precompute-ingest"
    );
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("must reject before fetch");
    };
    const result = await runPrecomputeIngest("211", {});
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      error: "shapley service not configured",
    });
    assert.equal(fetchCalls, 0);
    return;
  }
  process.env.SHAPLEY_INGEST_TOKEN = "test-ingest";
  const { getSnapshotUrl } = await import("@/lib/constants/config");
  const { baselineTag } = await import("@/lib/utils/sweep-tag");
  const { runPrecomputeIngest } = await import("@/lib/utils/precompute-ingest");
  const { EpochSnapshotError, fetchEpochSnapshot } = await import(
    "@/lib/utils/epoch-snapshot"
  );
  const { fetchMissingDiffShapes, putDiffShape } = await import(
    "@/lib/utils/shapley-remote"
  );
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const reported: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
  const baseTime = Date.now();
  let now = baseTime;
  let missing: unknown = [181, 182, 183, 211];
  let isSwept = false;
  let hasBaseline = false;
  let mismatch = false;
  let inputBuildable = true;
  let hasBaselineFailure = false;
  let hasCurrentPutFailure = false;
  let statusDelayMs = 0;
  let historyDelayMs = 0;
  let calls: string[] = [];
  const controller = new AbortController();
  let shouldAbortSnapshot = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url}`);
    if (url.startsWith("https://service.test")) {
      assert.equal(headers.get("authorization"), "Bearer test-compute");
      if (
        method === "PUT" ||
        url.endsWith("/precompute/link-estimates") ||
        url.endsWith("/precompute/baseline")
      )
        assert.equal(headers.get("x-ingest-token"), "test-ingest");
      if (url.includes("/shapley/baseline?")) {
        const tag = new URL(url).searchParams.get("tag");
        assert.equal(tag, baselineTag(211));
        return hasBaseline
          ? Response.json({
              tag,
              input_hash: "hash",
              method: "lp-test",
              operator_count: 0,
              values: {},
            })
          : Response.json({ status: "not-cached", tag }, { status: 404 });
      }
      if (url.includes("/status?")) {
        now += statusDelayMs;
        return Response.json({
          complete: isSwept,
          tag: new URL(url).searchParams.get("tag"),
        });
      }
      if (url.includes("/diff/missing?")) return Response.json({ missing });
      if (url.endsWith("/precompute/link-estimates"))
        return Response.json({ job_id: "sweep-test" }, { status: 202 });
      if (url.endsWith("/precompute/baseline")) {
        const submitted = JSON.parse(String(init?.body)) as { tag: string };
        assert.equal(submitted.tag, baselineTag(211));
        return hasBaselineFailure
          ? new Response("unavailable", { status: 503 })
          : Response.json(
              {
                status: "accepted",
                job_id: "baseline-test",
                input_hash: "hash",
                tag: submitted.tag,
              },
              { status: 202 },
            );
      }
      if (url.includes("/diff/shape/")) {
        const submitted = JSON.parse(String(init?.body)) as { epoch: number };
        assert.equal(submitted.epoch, Number(url.split("/").at(-1)));
        return new Response("", {
          status: hasCurrentPutFailure && submitted.epoch === 211 ? 502 : 201,
        });
      }
      throw new Error(`unexpected service request: ${url}`);
    }
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-ingest-token"), null);
    if (method === "HEAD") {
      now += 280_000;
      return new Response("", { status: 404 });
    }
    const epoch = [181, 182, 183, 211].find(
      (epoch) => url === getSnapshotUrl(epoch),
    );
    assert.ok(epoch, `unexpected snapshot URL ${url}`);
    if (epoch !== 211) {
      now += historyDelayMs;
      return new Response("missing", { status: 404 });
    }
    const raw = snapshot(mismatch ? 210 : epoch);
    if (!inputBuildable) delete raw.fetch_data.start_us;
    if (shouldAbortSnapshot) controller.abort();
    return Response.json(raw);
  };
  const run = () =>
    runPrecomputeIngest("211", {
      startedAtMs: baseTime,
      nowMs: () => now,
      ...(shouldAbortSnapshot ? { signal: controller.signal } : {}),
    });
  function reset(): void {
    calls = [];
    now = baseTime;
  }
  try {
    let result = await run();
    assert.equal(result.status, 200);
    assert.equal(result.body.sweep_job_id, "sweep-test");
    assert.equal(result.body.shapes?.records[211], "created");
    assert.equal(
      calls.filter((call) => call === `GET ${getSnapshotUrl(211)}`).length,
      1,
    );
    const sweepIndex = calls.findIndex(
      (call) => call === "POST https://service.test/precompute/link-estimates",
    );
    const firstHistoricalIndex = calls.findIndex(
      (call) =>
        call.startsWith("GET ") &&
        [181, 182, 183].some((epoch) => call.endsWith(getSnapshotUrl(epoch))),
    );
    assert.ok(sweepIndex >= 0 && sweepIndex < firstHistoricalIndex);
    assert.ok(
      calls.indexOf("PUT https://service.test/diff/shape/211") <
        firstHistoricalIndex,
    );

    reset();
    mismatch = true;
    result = await run();
    assert.equal(result.status, 422);
    assert.ok(
      !calls.some(
        (call) => call.startsWith("PUT ") || call.startsWith("POST "),
      ),
    );
    mismatch = false;

    reset();
    inputBuildable = false;
    result = await run();
    assert.equal(result.status, 422);
    assert.equal(result.body.shapes?.records[211], "created");
    inputBuildable = true;

    reset();
    hasBaselineFailure = true;
    result = await run();
    assert.equal(result.status, 200);
    assert.equal(result.body.sweep_job_id, "sweep-test");
    assert.ok(result.body.errors?.["baseline-publish"]);
    hasBaselineFailure = false;

    reset();
    hasCurrentPutFailure = true;
    result = await run();
    assert.equal(result.status, 502);
    assert.equal(result.body.sweep, "accepted");
    assert.equal(result.body.shapes?.records[211], "failed");
    hasCurrentPutFailure = false;

    reset();
    statusDelayMs = 200_000;
    result = await run();
    assert.equal(result.status, 200);
    historyDelayMs = 40_000;
    reset();
    result = await run();
    assert.equal(
      calls.filter((call) =>
        [181, 182, 183].some(
          (epoch) => call === `GET ${getSnapshotUrl(epoch)}`,
        ),
      ).length,
      1,
    );
    assert.equal(result.body.shapes?.deferred_epochs.length, 2);
    statusDelayMs = 0;
    historyDelayMs = 0;

    // Swept, shapes complete, no baseline alias: one download, one publish,
    // no sweep.
    reset();
    isSwept = true;
    missing = [];
    result = await run();
    assert.equal(result.status, 200);
    assert.equal(result.body.sweep, "already-swept");
    assert.equal(
      calls.filter((call) => call === `GET ${getSnapshotUrl(211)}`).length,
      1,
    );
    assert.ok(
      calls.includes("POST https://service.test/precompute/baseline"),
    );
    assert.ok(
      !calls.includes("POST https://service.test/precompute/link-estimates"),
    );
    assert.equal(
      (result.body.baseline as { status?: string } | undefined)?.status,
      "accepted",
    );

    // The alias is this fire's only output, so its failure is the status.
    reset();
    hasBaselineFailure = true;
    result = await run();
    assert.equal(result.status, 503);
    assert.equal(result.body.sweep, "already-swept");
    assert.ok(result.body.errors?.["baseline-publish"]);
    hasBaselineFailure = false;

    // Everything published: three status reads and no download.
    reset();
    hasBaseline = true;
    result = await run();
    assert.equal(result.status, 200);
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every((call) => call.startsWith("GET https://service.test")),
    );
    hasBaseline = false;
    isSwept = false;
    missing = [211, 211];
    await assert.rejects(
      fetchMissingDiffShapes(211, 31),
      /invalid missing-shape/,
    );
    missing = [180];
    await assert.rejects(
      fetchMissingDiffShapes(211, 31),
      /invalid missing-shape/,
    );
    missing = null;
    await assert.rejects(
      fetchMissingDiffShapes(211, 31),
      /invalid missing-shape/,
    );
    missing = [211];
    await assert.rejects(
      putDiffShape(211, { epoch: 210, links: [], contributors: [] }),
      /epoch mismatch/,
    );

    reset();
    result = await runPrecomputeIngest(null, {
      startedAtMs: baseTime,
      nowMs: () => now,
    });
    assert.equal(result.status, 504);
    assert.ok(calls.every((call) => call.startsWith("HEAD ")));

    reset();
    shouldAbortSnapshot = true;
    result = await run();
    assert.equal(result.status, 504);
    assert.ok(
      !calls.some(
        (call) => call.startsWith("PUT ") || call.startsWith("POST "),
      ),
    );
    shouldAbortSnapshot = false;

    for (const body of [
      '{"dz_epoch":"211"}',
      '{"dz_epoch":211,"fetch_data":{}}',
      "not-json",
    ]) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(fetchEpochSnapshot(211), EpochSnapshotError);
    }
    globalThis.fetch = async (_url, init) =>
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
      );
    // AbortSignal.timeout timers are unref'd, so without a live handle Node
    // would exit before the abort fires.
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(
        fetchEpochSnapshot(211, { timeoutMs: 10 }),
        (error: unknown) =>
          error instanceof EpochSnapshotError && error.category === "timeout",
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(reported.length > 0, "failures are reported");
    // INGEST_TOKEN is read at module load, so the missing-token case needs a
    // fresh process.
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/test-precompute-ingest.ts",
      "--missing-ingest",
    ]);
    // SHAPLEY_SERVICE_URL is read at module load too, so the missing-service
    // case also needs a fresh process.
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/test-precompute-ingest.ts",
      "--missing-service",
    ]);
    console.log("precompute ingestion: passed");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
