"use client";

import { useMemo, useState } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  Line,
  ZoomableGroup,
} from "react-simple-maps";
import Link from "next/link";
import { ZoomIn, ZoomOut, Maximize2, X } from "lucide-react";
import type { LiveTopology, LiveStatus } from "@/lib/types/live";
import {
  getContributorColor,
  getContributorDisplayName,
} from "@/lib/constants/config";

const GEO_URL = "/world-110m.json";
const DEFAULT_CENTER: [number, number] = [0, 30];
const DEFAULT_ZOOM = 1;
const PROJECTION_SCALE = 130;

type ColorMode = "contributor" | "utilization";

interface LiveMapProps {
  topology: LiveTopology;
  status: LiveStatus | undefined;
}

/**
 * Live topology map with two coloring modes:
 *   - contributor: arcs colored by contributor (default).
 *   - utilization: arcs colored by max(in, out)/bandwidth from /api/live/status,
 *     with cool→hot ramp. Surfaces hot corridors at a glance.
 *
 * Markers sized by metro device-count. Hover shows contributor + bandwidth.
 */
export function LiveMap({ topology, status }: LiveMapProps) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [center, setCenter] = useState<[number, number]>(DEFAULT_CENTER);
  const [mode, setMode] = useState<ColorMode>("contributor");
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string;
    sub: string;
  } | null>(null);
  // Selected metro code. Click a marker to drill in; click again to clear.
  const [selectedMetro, setSelectedMetro] = useState<string | null>(null);

  // Build metro coordinate lookup
  const metroByCode = useMemo(() => {
    const m = new Map<
      string,
      { code: string; name: string; lat: number; lng: number }
    >();
    for (const metro of topology.metros) {
      m.set(metro.code, {
        code: metro.code,
        name: metro.name,
        lat: metro.latitude,
        lng: metro.longitude,
      });
    }
    return m;
  }, [topology]);

  // Util by link pubkey from status. Upstream only ships the top-N most
  // utilised links (~10), so absence of data ≠ idle — it means "not measured".
  // We track that distinction so the map can render unknowns as neutral
  // grey rather than mis-labeling them as "0% utilised".
  const utilByPk = useMemo(() => {
    const m = new Map<string, number>();
    if (!status) return m;
    for (const t of status.topUtilLinks) {
      m.set(t.pk, Math.max(t.utilizationIn, t.utilizationOut));
    }
    return m;
  }, [status]);

  // Peak observed util in the dataset — used to rescale the colour ramp.
  // Real DZ utilisation rarely exceeds ~10%, so absolute thresholds
  // (25%/50%) make almost every measured link look "cool" and the visual
  // becomes useless. Rescaling against the peak gives meaningful ordinal
  // colour: top arc is always hot, half-of-peak is warm, etc.
  const peakUtilObserved = useMemo(() => {
    let max = 0;
    for (const v of utilByPk.values()) if (v > max) max = v;
    return max;
  }, [utilByPk]);

  // Aggregate arcs — dedupe by metro pair × contributor so we don't render
  // 4 visually identical arcs for parallel links between the same metros.
  type Arc = {
    key: string;
    from: [number, number];
    to: [number, number];
    contributor: string;
    pks: string[]; // all underlying link pubkeys
    bandwidthBps: number;
    peakUtil: number; // 0-1, only meaningful if hasUtilData
    hasUtilData: boolean; // true if ≥1 underlying link is in topUtilLinks
  };

  const arcs = useMemo<Arc[]>(() => {
    const grouped = new Map<string, Arc>();
    for (const link of topology.links) {
      const a = metroByCode.get(link.sideAMetro);
      const z = metroByCode.get(link.sideZMetro);
      if (!a || !z) continue;
      const pair = [link.sideAMetro, link.sideZMetro].sort().join("-");
      const key = `${link.contributorCode}:${pair}`;
      const measuredUtil = utilByPk.get(link.pk);
      const existing = grouped.get(key);
      if (existing) {
        existing.pks.push(link.pk);
        existing.bandwidthBps += link.bandwidthBps;
        if (measuredUtil != null) {
          existing.hasUtilData = true;
          if (measuredUtil > existing.peakUtil) existing.peakUtil = measuredUtil;
        }
      } else {
        grouped.set(key, {
          key,
          from: [a.lng, a.lat],
          to: [z.lng, z.lat],
          contributor: link.contributorCode,
          pks: [link.pk],
          bandwidthBps: link.bandwidthBps,
          peakUtil: measuredUtil ?? 0,
          hasUtilData: measuredUtil != null,
        });
      }
    }
    return Array.from(grouped.values());
  }, [topology, metroByCode, utilByPk]);

  // Per-metro device count for marker sizing
  const devicesByMetro = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of topology.devices) {
      m.set(d.metroCode, (m.get(d.metroCode) ?? 0) + 1);
    }
    return m;
  }, [topology]);

  // Bucket against the peak observed in the current dataset, not absolute
  // thresholds. Real DZ link utilisation is typically <10% — absolute
  // 25%/50% bands would render every measured arc as "cool".
  const utilColor = (
    u: number,
    hasData: boolean,
    peak: number,
  ): string => {
    if (!hasData) return "rgba(243,238,217,0.10)"; // unmeasured
    if (peak <= 0) return "rgba(243,238,217,0.10)";
    const ratio = u / peak;
    if (ratio >= 0.66) return "#ff7a7a"; // top third of measured
    if (ratio >= 0.33) return "#fce184"; // middle third
    return "#80d0ff"; // bottom third
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.5, 8));
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.5, 1));
  const handleReset = () => {
    setZoom(DEFAULT_ZOOM);
    setCenter(DEFAULT_CENTER);
  };

  // Drill-down data for the currently selected metro. Computed lazily —
  // null when no metro is selected so the panel doesn't render.
  const selectedDetail = useMemo(() => {
    if (!selectedMetro) return null;
    const metro = topology.metros.find((mm) => mm.code === selectedMetro);
    if (!metro) return null;
    const devicesHere = topology.devices.filter(
      (d) => d.metroCode === selectedMetro,
    );
    const linksHere = topology.links.filter(
      (l) =>
        l.sideAMetro === selectedMetro || l.sideZMetro === selectedMetro,
    );
    // Group devices by contributor.
    const byContributor = new Map<
      string,
      { code: string; deviceCount: number; linkCount: number }
    >();
    for (const d of devicesHere) {
      const c = d.contributorCode;
      const e = byContributor.get(c) ?? {
        code: c,
        deviceCount: 0,
        linkCount: 0,
      };
      e.deviceCount += 1;
      byContributor.set(c, e);
    }
    for (const l of linksHere) {
      const c = l.contributorCode;
      const e = byContributor.get(c) ?? {
        code: c,
        deviceCount: 0,
        linkCount: 0,
      };
      e.linkCount += 1;
      byContributor.set(c, e);
    }
    const contributors = [...byContributor.values()].sort(
      (a, b) => b.deviceCount - a.deviceCount,
    );
    const totalBandwidth = linksHere.reduce(
      (s, l) => s + l.bandwidthBps,
      0,
    );
    return { metro, devicesHere, linksHere, contributors, totalBandwidth };
  }, [selectedMetro, topology]);

  const fmtBps = (bps: number) => {
    if (bps >= 1e12) return `${(bps / 1e12).toFixed(1)} Tbps`;
    if (bps >= 1e9) return `${(bps / 1e9).toFixed(0)} Gbps`;
    return `${(bps / 1e6).toFixed(0)} Mbps`;
  };

  return (
    <div className="space-y-3">
    <div className="border border-border bg-surface relative overflow-hidden">
      {/* Controls bar */}
      <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          <span>Live network map</span>
          {status && (
            <span className="text-cream-30">
              · {status.linkHealth.healthy}/{status.linkHealth.total} healthy
            </span>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Color by"
          className="inline-flex border border-cream-15 bg-surface text-xs font-mono"
        >
          {(["contributor", "utilization"] as const).map((m, i) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 transition-colors ${
                  i > 0 ? "border-l border-cream-15" : ""
                } ${
                  active
                    ? "bg-cream text-dark"
                    : "text-cream-60 hover:text-cream"
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ scale: PROJECTION_SCALE }}
        width={800}
        height={360}
        style={{ width: "100%", height: "auto" }}
      >
        <ZoomableGroup
          center={center}
          zoom={zoom}
          onMoveEnd={({ coordinates, zoom: z }) => {
            setCenter(coordinates);
            setZoom(z);
          }}
          minZoom={1}
          maxZoom={8}
        >
          <Geographies geography={GEO_URL}>
            {({ geographies }) =>
              geographies.map((geo) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill="var(--surface)"
                  stroke="var(--surface-2)"
                  strokeWidth={0.4 / zoom}
                  style={{
                    default: { outline: "none" },
                    hover: { outline: "none", fill: "var(--surface-2)" },
                    pressed: { outline: "none" },
                  }}
                />
              ))
            }
          </Geographies>

          {/* Arcs */}
          {arcs.map((arc) => {
            const stroke =
              mode === "utilization"
                ? utilColor(arc.peakUtil, arc.hasUtilData, peakUtilObserved)
                : getContributorColor(arc.contributor);
            const opacity =
              mode === "utilization"
                ? arc.hasUtilData
                  ? 0.85
                  : 0.35
                : 0.55;
            // Width scales with rank-against-peak in util mode so the
            // hottest arc is visibly thicker than the coolest, even when
            // peak is 8%.
            const utilRatio =
              peakUtilObserved > 0 && arc.hasUtilData
                ? arc.peakUtil / peakUtilObserved
                : 0;
            return (
              <Line
                key={arc.key}
                from={arc.from}
                to={arc.to}
                stroke={stroke}
                strokeOpacity={opacity}
                strokeWidth={
                  ((mode === "utilization"
                    ? 0.6 + utilRatio * 1.6
                    : 0.9) /
                    zoom) *
                  (arc.pks.length > 1 ? 1.3 : 1)
                }
                strokeLinecap="round"
              />
            );
          })}

          {/* Arc midpoint markers — hover shows summary */}
          {arcs.map((arc) => {
            const mid: [number, number] = [
              (arc.from[0] + arc.to[0]) / 2,
              (arc.from[1] + arc.to[1]) / 2,
            ];
            return (
              <Marker
                key={`mid-${arc.key}`}
                coordinates={mid}
                onMouseEnter={(e: React.MouseEvent) => {
                  const rect = (e.target as SVGElement)
                    .closest("svg")
                    ?.getBoundingClientRect();
                  if (rect) {
                    setHover({
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      label: getContributorDisplayName(arc.contributor),
                      sub: `${arc.pks.length} link${arc.pks.length > 1 ? "s" : ""} · ${fmtBps(arc.bandwidthBps)}${arc.hasUtilData ? ` · ${(arc.peakUtil * 100).toFixed(1)}% util` : " · util not measured"}`,
                    });
                  }
                }}
                onMouseLeave={() => setHover(null)}
              >
                <circle
                  r={1.5 / zoom}
                  fill="transparent"
                  pointerEvents="all"
                  style={{ cursor: "pointer" }}
                />
              </Marker>
            );
          })}

          {/* Metro markers — click to drill into metro details */}
          {topology.metros.map((m) => {
            const devices = devicesByMetro.get(m.code) ?? 0;
            const r = Math.min(1.4 + devices * 0.12, 4) / zoom;
            const isSelected = selectedMetro === m.code;
            return (
              <Marker
                key={m.pk}
                coordinates={[m.longitude, m.latitude]}
                onMouseEnter={(e: React.MouseEvent) => {
                  const rect = (e.target as SVGElement)
                    .closest("svg")
                    ?.getBoundingClientRect();
                  if (rect) {
                    setHover({
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      label: m.name,
                      sub: `${m.code.toUpperCase()} · ${devices} device${devices !== 1 ? "s" : ""} · click to drill in`,
                    });
                  }
                }}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  setSelectedMetro((prev) => (prev === m.code ? null : m.code));
                  setHover(null);
                }}
              >
                {isSelected && (
                  <circle
                    r={(r + 1.5) / 1}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={0.6 / zoom}
                    strokeOpacity={0.9}
                  />
                )}
                <circle
                  r={r}
                  fill={isSelected ? "var(--primary)" : "var(--foreground)"}
                  fillOpacity={0.85}
                  stroke="var(--surface-2)"
                  strokeWidth={0.3 / zoom}
                  style={{ cursor: "pointer" }}
                />
              </Marker>
            );
          })}
        </ZoomableGroup>
      </ComposableMap>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-cream-15 bg-background/95 backdrop-blur px-2 py-1.5 text-xs font-mono text-cream shadow-lg"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <div className="font-medium tracking-tight">{hover.label}</div>
          <div className="text-cream-40">{hover.sub}</div>
        </div>
      )}

      <div className="absolute right-2 bottom-2 flex flex-col gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={handleZoomIn}
          className="size-7 border border-cream-15 bg-background/80 backdrop-blur text-cream-60 hover:text-cream hover:bg-background transition-colors flex items-center justify-center"
        >
          <ZoomIn className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={handleZoomOut}
          className="size-7 border border-cream-15 bg-background/80 backdrop-blur text-cream-60 hover:text-cream hover:bg-background transition-colors flex items-center justify-center"
        >
          <ZoomOut className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Reset view"
          onClick={handleReset}
          className="size-7 border border-cream-15 bg-background/80 backdrop-blur text-cream-60 hover:text-cream hover:bg-background transition-colors flex items-center justify-center"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      {/* Legend — colours are relative to the peak observed link
           (typically <10%), not absolute bandwidth %. Upstream only
           ships utilisation for the top ~10 links so most arcs render
           "no data" rather than "idle". */}
      {mode === "utilization" && (
        <div className="absolute left-2 bottom-2 flex items-center gap-2 border border-cream-15 bg-background/80 backdrop-blur px-2 py-1.5 text-xs font-mono text-cream-60">
          <span>
            relative util
            {peakUtilObserved > 0 && (
              <span className="text-cream-40">
                {" "}
                · peak {(peakUtilObserved * 100).toFixed(1)}%
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-[rgba(243,238,217,0.10)] border border-cream-15" />
            no data
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-[#80d0ff]" />
            low
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-[#fce184]" />
            mid
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-[#ff7a7a]" />
            high
          </span>
        </div>
      )}
    </div>

    {/* Inline metro drill-down panel — appears when a metro marker is
        clicked. Shows contributors operating in the metro, devices, and
        links touching it. Click the same marker (or the X) to close. */}
    {selectedDetail && (
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-3 min-w-0">
            <h3 className="font-display text-base tracking-tight truncate">
              {selectedDetail.metro.name}
            </h3>
            <span className="text-[11px] font-mono text-cream-40 uppercase tracking-[0.14em]">
              {selectedDetail.metro.code}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close metro details"
            onClick={() => setSelectedMetro(null)}
            className="size-7 border border-border flex items-center justify-center hover:bg-surface-2/60 transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <Stat label="Devices" value={String(selectedDetail.devicesHere.length)} />
          <Stat label="Links" value={String(selectedDetail.linksHere.length)} />
          <Stat
            label="Contributors"
            value={String(selectedDetail.contributors.length)}
          />
          <Stat
            label="Bandwidth"
            value={fmtBps(selectedDetail.totalBandwidth)}
          />
        </div>

        {selectedDetail.contributors.length > 0 ? (
          <div>
            <div className="border-b border-border px-4 py-2 text-[11px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
              Contributors in {selectedDetail.metro.code}
            </div>
            <ul>
              {selectedDetail.contributors.map((c) => (
                <li
                  key={c.code}
                  className="border-b border-border last:border-b-0"
                >
                  <Link
                    href={`/contributors/${c.code}`}
                    className="grid grid-cols-12 gap-3 items-center px-4 py-2.5 hover:bg-surface-2/40 transition-colors"
                  >
                    <span className="col-span-6 flex items-center gap-2.5 min-w-0">
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getContributorColor(c.code) }}
                      />
                      <span className="text-sm truncate">
                        {getContributorDisplayName(c.code)}
                      </span>
                    </span>
                    <span className="col-span-2 text-right tabular-nums font-mono text-xs text-cream-60">
                      {c.deviceCount} dev
                    </span>
                    <span className="col-span-2 text-right tabular-nums font-mono text-xs text-cream-60">
                      {c.linkCount} link{c.linkCount !== 1 ? "s" : ""}
                    </span>
                    <span className="col-span-2 text-right text-[11px] font-mono text-cream-40">
                      view →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="px-4 py-6 text-sm text-muted-foreground font-mono">
            No contributors with devices in this metro.
          </div>
        )}
      </div>
    )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className="text-sm font-mono tabular-nums text-foreground mt-0.5">
        {value}
      </div>
    </div>
  );
}
