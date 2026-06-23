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
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import type { ParsedSnapshot } from "@/lib/types/contributor";
import { getContributorColor } from "@/lib/constants/config";

/**
 * Interactive map for the simulator. Two-step click-to-draft:
 *   1. Click a city → marks Side A.
 *   2. Click a second city → emits onPairSelect(cityA, cityZ) for the parent
 *      to add the link.
 * Existing links flagged for removal are rendered with a struck-through red
 * arc. Drafted new links are rendered as bright green arcs.
 *
 * The map only knows about location codes; the parent owns the actual
 * add/remove logic and wires bandwidth + RTT inputs.
 */

const GEO_URL = "/world-110m.json";
const DEFAULT_CENTER: [number, number] = [0, 30];
const DEFAULT_ZOOM = 1;
const PROJECTION_SCALE = 130;

interface City {
  code: string; // locationCode
  name: string;
  country: string;
  lat: number;
  lng: number;
  validatorCount: number;
  contributorCount: number;
  isContributor: boolean; // true if the active contributor has a device here
}

interface ArcPoint {
  from: [number, number];
  to: [number, number];
}

export interface SimulatorMapProps {
  snapshot: ParsedSnapshot;
  /** Active contributor — links owned by them get clickable removal. */
  contributorCode: string | null;
  /** Pubkeys of existing links flagged for removal. */
  removedLinkPubkeys: Set<string>;
  /** Drafted new links: { cityA, cityZ }. Bandwidth/RTT live in the form. */
  addedLinks: Array<{ cityA: string; cityZ: string }>;
  /** Called when the user clicks two distinct cities in sequence. */
  onPairSelect: (cityA: string, cityZ: string) => void;
  /** Called when the user clicks an existing link arc owned by the active contributor. */
  onLinkClick: (pubkey: string) => void;
}

function cityKey(side: { locationCode: string }): string {
  return side.locationCode;
}

export function SimulatorMap({
  snapshot,
  contributorCode,
  removedLinkPubkeys,
  addedLinks,
  onPairSelect,
  onLinkClick,
}: SimulatorMapProps) {
  const [pendingA, setPendingA] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    city: City;
  } | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [center, setCenter] = useState<[number, number]>(DEFAULT_CENTER);

  // Build city lookup keyed by locationCode (the same identifier the
  // simulator's add-link form uses). Aggregates per-contributor presence and
  // validator counts.
  const cities = useMemo(() => {
    const map = new Map<string, City>();
    for (const c of snapshot.contributors) {
      for (const link of c.links) {
        for (const side of [link.sideA, link.sideZ]) {
          if (!side.locationCode || !side.lat || !side.lng) continue;
          const k = cityKey(side);
          if (!map.has(k)) {
            map.set(k, {
              code: k,
              name: side.city || side.locationCode,
              country: side.country,
              lat: side.lat,
              lng: side.lng,
              validatorCount: 0,
              contributorCount: 0,
              isContributor: false,
            });
          }
          const entry = map.get(k)!;
          if (c.code === contributorCode) entry.isContributor = true;
        }
      }
    }

    // Layer in validator counts + contributor coverage from cityDemands.
    const codeToContribs = new Map<string, Set<string>>();
    for (const c of snapshot.contributors) {
      for (const link of c.links) {
        for (const side of [link.sideA, link.sideZ]) {
          if (!side.locationCode) continue;
          if (!codeToContribs.has(side.locationCode)) {
            codeToContribs.set(side.locationCode, new Set());
          }
          codeToContribs.get(side.locationCode)!.add(c.code);
        }
      }
    }
    for (const cd of snapshot.cityDemands) {
      const entry = map.get(cd.locationCode);
      if (!entry) continue;
      entry.validatorCount = cd.validatorCount;
      entry.contributorCount = codeToContribs.get(cd.locationCode)?.size ?? 0;
    }

    return Array.from(map.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }, [snapshot, contributorCode]);

  const cityByCode = useMemo(() => {
    const m = new Map<string, City>();
    for (const c of cities) m.set(c.code, c);
    return m;
  }, [cities]);

  // Existing arcs for the active contributor.
  const contributor = contributorCode
    ? snapshot.contributors.find((c) => c.code === contributorCode)
    : null;

  type ExistingArc = ArcPoint & {
    pubkey: string;
    cityA: string;
    cityZ: string;
    color: string;
    flagged: boolean;
  };
  type OtherArc = ArcPoint & { contributor: string; color: string };

  const { ownArcs, otherArcs } = useMemo(() => {
    const own: ExistingArc[] = [];
    const other: OtherArc[] = [];
    for (const c of snapshot.contributors) {
      const ownsArcs = c.code === contributorCode;
      for (const link of c.links) {
        const a = cityByCode.get(link.sideA.locationCode);
        const z = cityByCode.get(link.sideZ.locationCode);
        if (!a || !z) continue;
        if (ownsArcs) {
          own.push({
            from: [a.lng, a.lat],
            to: [z.lng, z.lat],
            pubkey: link.pubkey,
            cityA: link.sideA.locationCode,
            cityZ: link.sideZ.locationCode,
            color: getContributorColor(c.code),
            flagged: removedLinkPubkeys.has(link.pubkey),
          });
        } else {
          other.push({
            from: [a.lng, a.lat],
            to: [z.lng, z.lat],
            contributor: c.code,
            color: getContributorColor(c.code),
          });
        }
      }
    }
    return { ownArcs: own, otherArcs: other };
  }, [snapshot, contributorCode, cityByCode, removedLinkPubkeys]);

  const draftArcs = useMemo(() => {
    const out: Array<ArcPoint & { key: string }> = [];
    for (let i = 0; i < addedLinks.length; i++) {
      const a = cityByCode.get(addedLinks[i].cityA);
      const z = cityByCode.get(addedLinks[i].cityZ);
      if (!a || !z) continue;
      out.push({
        key: `${addedLinks[i].cityA}-${addedLinks[i].cityZ}-${i}`,
        from: [a.lng, a.lat],
        to: [z.lng, z.lat],
      });
    }
    return out;
  }, [addedLinks, cityByCode]);

  const handleCityClick = (code: string) => {
    if (!pendingA) {
      setPendingA(code);
      return;
    }
    if (pendingA === code) {
      // toggle off
      setPendingA(null);
      return;
    }
    onPairSelect(pendingA, code);
    setPendingA(null);
  };

  const handleArcClick = (a: ExistingArc) => {
    if (!contributorCode) return;
    onLinkClick(a.pubkey);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.5, 8));
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.5, 1));
  const handleReset = () => {
    setZoom(DEFAULT_ZOOM);
    setCenter(DEFAULT_CENTER);
    setPendingA(null);
  };

  const helperText = !contributorCode
    ? "Pick a contributor above to start drafting links."
    : pendingA
    ? `Click a second city to add a link from ${pendingA.toUpperCase()}, or click ${pendingA.toUpperCase()} again to cancel.`
    : "Click a city to start drafting a new link. Click an existing dashed line to flag it for removal.";

  return (
    <div className="space-y-2">
      <div className="border border-cream-15 bg-surface relative overflow-hidden">
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

            {/* Other contributors' links — dim background context */}
            {otherArcs.map((arc, i) => (
              <Line
                key={`other-${i}`}
                from={arc.from}
                to={arc.to}
                stroke={arc.color}
                strokeOpacity={0.1}
                strokeWidth={0.5 / zoom}
              />
            ))}

            {/* Active contributor's links */}
            {ownArcs.map((arc) => (
              <Line
                key={`own-${arc.pubkey}`}
                from={arc.from}
                to={arc.to}
                stroke={arc.flagged ? "#ff7a7a" : arc.color}
                strokeOpacity={arc.flagged ? 0.7 : 0.6}
                strokeWidth={(arc.flagged ? 1.6 : 1.2) / zoom}
                strokeDasharray={
                  arc.flagged ? `${2 / zoom} ${2 / zoom}` : undefined
                }
              />
            ))}

            {/* Invisible click targets for own-arc midpoints — flag for removal */}
            {ownArcs.map((arc) => {
              const mid: [number, number] = [
                (arc.from[0] + arc.to[0]) / 2,
                (arc.from[1] + arc.to[1]) / 2,
              ];
              return (
                <Marker
                  key={`hit-${arc.pubkey}`}
                  coordinates={mid}
                  onClick={() => handleArcClick(arc)}
                >
                  <circle
                    r={3 / zoom}
                    fill={arc.flagged ? "#ff7a7a" : arc.color}
                    fillOpacity={arc.flagged ? 0.9 : 0.4}
                    stroke="var(--surface-2)"
                    strokeWidth={0.3 / zoom}
                    style={{ cursor: "pointer" }}
                  />
                </Marker>
              );
            })}

            {/* Drafted new links */}
            {draftArcs.map((arc) => (
              <Line
                key={arc.key}
                from={arc.from}
                to={arc.to}
                stroke="#80d0ff"
                strokeOpacity={0.9}
                strokeWidth={1.6 / zoom}
                strokeDasharray={`${4 / zoom} ${2 / zoom}`}
              />
            ))}

            {/* City markers */}
            {cities.map((city) => {
              const baseR = Math.min(2 + city.contributorCount * 0.3, 5) / zoom;
              const isPending = pendingA === city.code;
              const isContrib = city.isContributor;
              const r = isPending ? baseR + 1.5 / zoom : baseR;
              return (
                <Marker
                  key={city.code}
                  coordinates={[city.lng, city.lat]}
                  onMouseEnter={(e: React.MouseEvent) => {
                    const rect = (e.target as SVGElement)
                      .closest("svg")
                      ?.getBoundingClientRect();
                    if (rect) {
                      setHover({
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                        city,
                      });
                    }
                  }}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => handleCityClick(city.code)}
                >
                  {isPending && (
                    <circle
                      r={(r + 4) / 1}
                      fill="none"
                      stroke="#80d0ff"
                      strokeWidth={0.6 / zoom}
                      strokeOpacity={0.8}
                    >
                      <animate
                        attributeName="r"
                        from={`${r}`}
                        to={`${r + 6}`}
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                      <animate
                        attributeName="stroke-opacity"
                        from="0.8"
                        to="0"
                        dur="1.4s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  )}
                  <circle
                    r={r}
                    fill={
                      isPending
                        ? "#80d0ff"
                        : isContrib
                        ? "var(--foreground)"
                        : "var(--cream-30, rgba(243,238,217,0.3))"
                    }
                    stroke={isPending ? "#80d0ff" : "var(--surface-2)"}
                    strokeWidth={0.4 / zoom}
                    style={{ cursor: "pointer" }}
                  />
                </Marker>
              );
            })}
          </ZoomableGroup>
        </ComposableMap>

        {/* Tooltip */}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-cream-15 bg-background/95 backdrop-blur px-2 py-1.5 text-xs font-mono text-cream shadow-lg"
            style={{ left: hover.x, top: hover.y - 8 }}
          >
            <div className="font-medium tracking-tight">
              {hover.city.name}
              <span className="text-cream-30 ml-1">
                {hover.city.code.toUpperCase()}
              </span>
            </div>
            <div className="text-cream-40">
              {hover.city.contributorCount} contrib
              {hover.city.contributorCount !== 1 ? "s" : ""} ·{" "}
              {hover.city.validatorCount} validators
            </div>
          </div>
        )}

        {/* Zoom controls */}
        <div className="absolute right-2 top-2 flex flex-col gap-1">
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
      </div>

      <p className="text-xs text-cream-40 font-mono leading-relaxed">
        {helperText}
        <span className="ml-2 text-cream-30">
          <span className="inline-block size-1.5 rounded-full bg-foreground align-middle mr-1" />
          your metros ·
          <span className="inline-block size-1.5 rounded-full bg-cream-30 align-middle mx-1" />
          others ·
          <span className="inline-block size-1.5 align-middle ml-1 mr-0.5 border-t border-dashed border-[#80d0ff] w-3" />
          drafted ·
          <span className="inline-block size-1.5 align-middle ml-1 mr-0.5 border-t border-dashed border-[#ff7a7a] w-3" />
          flagged for removal
        </span>
      </p>
    </div>
  );
}
