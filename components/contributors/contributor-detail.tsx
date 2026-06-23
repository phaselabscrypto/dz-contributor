"use client";

import type { Contributor } from "@/lib/types/contributor";
import { Badge } from "@/components/ui/badge";
import { formatLatencyMs, formatBandwidth, shortenPubkey } from "@/lib/utils/format";

interface ContributorDetailProps {
  contributor: Contributor;
}

function getHealthBadgeClass(health: string): string {
  if (health === "Healthy") return "bg-green/10 text-green border-green/20";
  if (health === "Pending") return "bg-amber/10 text-amber border-amber/20";
  return "bg-red/10 text-red border-red/20";
}

export function ContributorDetail({ contributor }: ContributorDetailProps) {
  return (
    <div className="space-y-6">
      {/* Links */}
      <div>
        <h4 className="text-sm font-medium text-cream-60 mb-3">
          Links ({contributor.linkCount})
        </h4>
        <div className="grid gap-2">
          {contributor.links.map((link) => (
            <div
              key={link.pubkey}
              className="flex flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-1.5 rounded-lg bg-cream-5 border border-cream-8 px-3 sm:px-4 py-2 sm:py-2.5 text-sm"
            >
              <div className="min-w-[120px]">
                <span className="text-cream-80">
                  {link.sideA.city || link.sideA.locationCode}
                </span>
              </div>
              <span className="text-cream-20">→</span>
              <div className="min-w-[120px]">
                <span className="text-cream-80">
                  {link.sideZ.city || link.sideZ.locationCode}
                </span>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <Badge variant="secondary" className="text-xs">
                  {link.linkType}
                </Badge>
                <span className="text-cream-40 text-xs">
                  {formatLatencyMs(link.delayMs * 1_000_000)}
                </span>
                <span className="text-cream-40 text-xs">
                  {formatBandwidth(link.bandwidthGbps)}
                </span>
                <Badge
                  variant="secondary"
                  className={getHealthBadgeClass(link.health)}
                >
                  {link.health}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Devices */}
      <div>
        <h4 className="text-sm font-medium text-cream-60 mb-3">
          Devices ({contributor.deviceCount})
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {contributor.devices.map((device) => (
            <div
              key={device.pubkey}
              className="flex items-center justify-between rounded-lg bg-cream-5 border border-cream-8 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="text-cream-60">
                  {device.locationName || device.locationCode}
                </span>
                <span className="text-cream-20 text-xs">
                  {device.deviceType}
                </span>
              </div>
              <span className="text-cream-30 text-xs">
                {shortenPubkey(device.pubkey)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
