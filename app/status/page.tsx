"use client";

import { PageHeader } from "@/components/ui/page-header";
import { useHealth, useLiveStatus, type SourceHealth } from "@/lib/hooks/use-live";
import { LoadingState, ErrorState } from "@/components/ui/states";
import { CheckCircle2, AlertTriangle, XCircle, MinusCircle } from "lucide-react";

function StatusIcon({ status }: { status: SourceHealth["status"] }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="size-4 text-emerald-400" />;
    case "degraded":
      return <AlertTriangle className="size-4 text-amber-400" />;
    case "down":
      return <XCircle className="size-4 text-red-400" />;
    case "disabled":
      return <MinusCircle className="size-4 text-cream-30" />;
  }
}

function statusLabel(s: SourceHealth["status"]) {
  switch (s) {
    case "ok":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Down";
    case "disabled":
      return "Not configured";
  }
}

function fmtLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function errorLabel(code: SourceHealth["errorCode"]): string | null {
  if (!code) return null;
  switch (code) {
    case "timeout":
      return "Timed out";
    case "network":
      return "Network error";
    case "parse":
      return "Bad response";
    case "unknown":
      return "Unknown error";
  }
}

export default function StatusPage() {
  const { data: health, isLoading, error, mutate } = useHealth();
  const { data: linkStatus } = useLiveStatus();

  if (error && !health) {
    return (
      <>
        <PageHeader title="Status" description="Live source health" />
        <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6">
          <ErrorState
            title="Couldn't load /api/health"
            message={(error as Error).message}
            onRetry={() => mutate()}
          />
        </div>
      </>
    );
  }
  if (isLoading || !health) {
    return (
      <>
        <PageHeader title="Status" description="Live source health" />
        <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6">
          <LoadingState label="Probing sources" />
        </div>
      </>
    );
  }

  const overallTone =
    health.overall === "ok"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
      : health.overall === "degraded"
      ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
      : "border-red-500/30 bg-red-500/5 text-red-300";

  return (
    <>
      <PageHeader
        title="Status"
        description="Live source health for every upstream the site depends on."
      />
      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 max-w-3xl mx-auto w-full space-y-6">
        <div
          className={`border ${overallTone} px-4 py-3 flex items-center justify-between`}
        >
          <div className="flex items-center gap-3">
            <span
              className={`size-2.5 rounded-full animate-pulse ${
                health.overall === "ok"
                  ? "bg-emerald-400"
                  : health.overall === "degraded"
                  ? "bg-amber-400"
                  : "bg-red-400"
              }`}
            />
            <span className="font-display text-sm uppercase tracking-[0.08em]">
              {health.overall === "ok"
                ? "All systems operational"
                : health.overall === "degraded"
                ? "Some sources degraded"
                : "Source outage detected"}
            </span>
          </div>
          <span className="text-xs font-mono text-muted-foreground">
            {new Date(health.checkedAt).toLocaleTimeString()}
          </span>
        </div>

        <div className="border border-border bg-surface overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                <th className="px-3 py-2 text-left font-normal">Source</th>
                <th className="px-3 py-2 text-left font-normal">Status</th>
                <th className="px-3 py-2 text-right font-normal">Latency</th>
                <th className="px-3 py-2 text-right font-normal hidden sm:table-cell">
                  HTTP
                </th>
              </tr>
            </thead>
            <tbody>
              {health.sources.map((s) => (
                <tr
                  key={s.name}
                  className="border-b border-border last:border-b-0 align-top"
                >
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-xs text-foreground">
                      {s.name}
                    </div>
                    <div className="text-xs text-cream-30 font-mono truncate max-w-[18rem]">
                      {s.host}
                    </div>
                    {errorLabel(s.errorCode) && (
                      <div className="text-xs text-red-400/80 font-mono mt-0.5">
                        {errorLabel(s.errorCode)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={s.status} />
                      <span className="text-xs">{statusLabel(s.status)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-mono text-xs">
                    {fmtLatency(s.latencyMs)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-mono text-xs hidden sm:table-cell">
                    {s.httpStatus ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {linkStatus && (
          <div className="border border-border bg-surface px-4 py-3 space-y-2">
            <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
              Network link health (from malbeclabs/status)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-cream-30 uppercase tracking-[0.12em] font-mono">
                  Healthy
                </div>
                <div className="font-mono tabular-nums text-emerald-300">
                  {linkStatus.linkHealth.healthy}
                </div>
              </div>
              <div>
                <div className="text-xs text-cream-30 uppercase tracking-[0.12em] font-mono">
                  Degraded
                </div>
                <div className="font-mono tabular-nums text-amber-300">
                  {linkStatus.linkHealth.degraded}
                </div>
              </div>
              <div>
                <div className="text-xs text-cream-30 uppercase tracking-[0.12em] font-mono">
                  Unhealthy
                </div>
                <div className="font-mono tabular-nums text-red-300">
                  {linkStatus.linkHealth.unhealthy}
                </div>
              </div>
              <div>
                <div className="text-xs text-cream-30 uppercase tracking-[0.12em] font-mono">
                  Total
                </div>
                <div className="font-mono tabular-nums">
                  {linkStatus.linkHealth.total}
                </div>
              </div>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground font-mono">
          Auto-refreshes every 30s. Source-level &ldquo;down&rdquo; trumps link
          health for the overall status. See{" "}
          <a
            href="/methodology"
            className="underline decoration-dotted hover:text-foreground"
          >
            /methodology
          </a>{" "}
          for what each source feeds.
        </p>
      </div>
    </>
  );
}
