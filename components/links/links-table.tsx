"use client";

import type { Link } from "@/lib/types/contributor";
import { DenseTable, DTHead, DTBody, DTRow, DTH, DTD } from "@/components/ui/dense-table";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";

interface LinksTableProps {
  links: Link[];
}

export function LinksTable({ links }: LinksTableProps) {
  const [selectedLink, setSelectedLink] = useState<Link | null>(null);

  const formatBandwidth = (gbps: number) => `${gbps.toFixed(1)}`;
  const formatDelay = (ms: number) => `${ms.toFixed(1)}`;
  const formatJitter = (ms: number) => `${ms.toFixed(1)}`;

  const healthColor = (health: string) => {
    const lower = health.toLowerCase();
    if (lower === "healthy") return "text-positive";
    if (lower === "degraded") return "text-warning";
    if (lower === "unhealthy") return "text-negative";
    return "text-muted-foreground";
  };

  return (
    <>
      <DenseTable>
        <DTHead>
          <DTRow>
            <DTH>Contributor</DTH>
            <DTH>Side A</DTH>
            <DTH>City A</DTH>
            <DTH>Side Z</DTH>
            <DTH>City Z</DTH>
            <DTH>Type</DTH>
            <DTH align="right">Bandwidth</DTH>
            <DTH align="right">Delay</DTH>
            <DTH align="right">Jitter</DTH>
            <DTH>Health</DTH>
            <DTH>Status</DTH>
            <DTH align="center">Actions</DTH>
          </DTRow>
        </DTHead>
        <DTBody>
          {links.map((link) => (
            <DTRow key={link.pubkey}>
              <DTD mono className="font-semibold">{link.contributorCode}</DTD>
              <DTD mono className="text-xs">{link.sideA.devicePubkey.slice(0, 8)}</DTD>
              <DTD className="text-xs">{link.sideA.city}</DTD>
              <DTD mono className="text-xs">{link.sideZ.devicePubkey.slice(0, 8)}</DTD>
              <DTD className="text-xs">{link.sideZ.city}</DTD>
              <DTD className="text-xs uppercase">{link.linkType}</DTD>
              <DTD align="right" mono>{formatBandwidth(link.bandwidthGbps)} Gbps</DTD>
              <DTD align="right" mono>{formatDelay(link.delayMs)} ms</DTD>
              <DTD align="right" mono>{formatJitter(link.jitterMs)} ms</DTD>
              <DTD className={`text-xs uppercase font-semibold ${healthColor(link.health)}`}>
                {link.health}
              </DTD>
              <DTD className="text-xs uppercase text-muted-foreground">Active</DTD>
              <DTD align="center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedLink(link)}
                  className="h-6 px-2 text-xs"
                >
                  Details
                </Button>
              </DTD>
            </DTRow>
          ))}
        </DTBody>
      </DenseTable>

      {selectedLink && (
        <LinkDetailsDialog
          link={selectedLink}
          onClose={() => setSelectedLink(null)}
        />
      )}
    </>
  );
}

interface LinkDetailsDialogProps {
  link: Link;
  onClose: () => void;
}

function LinkDetailsDialog({ link, onClose }: LinkDetailsDialogProps) {
  return (
    <Dialog open onOpenChange={onClose}>
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
        <div className="bg-surface border border-border p-6 max-w-2xl w-full mx-4">
          <h2 className="text-lg font-display font-bold mb-4">Link Details</h2>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Contributor</p>
              <p className="font-mono font-semibold">{link.contributorCode}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Link Type</p>
              <p className="font-mono">{link.linkType}</p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Side A Device</p>
              <p className="font-mono text-sm">{link.sideA.devicePubkey}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Side Z Device</p>
              <p className="font-mono text-sm">{link.sideZ.devicePubkey}</p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Side A Location</p>
              <p className="text-sm">{link.sideA.city}, {link.sideA.country}</p>
              <p className="font-mono text-xs text-muted-foreground mt-1">({link.sideA.lat.toFixed(4)}, {link.sideA.lng.toFixed(4)})</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Side Z Location</p>
              <p className="text-sm">{link.sideZ.city}, {link.sideZ.country}</p>
              <p className="font-mono text-xs text-muted-foreground mt-1">({link.sideZ.lat.toFixed(4)}, {link.sideZ.lng.toFixed(4)})</p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Bandwidth</p>
              <p className="font-mono text-lg font-semibold">{link.bandwidthGbps.toFixed(1)} Gbps</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Health</p>
              <p className={`font-semibold ${link.health.toLowerCase() === 'healthy' ? 'text-positive' : link.health.toLowerCase() === 'degraded' ? 'text-warning' : 'text-negative'}`}>
                {link.health}
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Delay</p>
              <p className="font-mono">{link.delayMs.toFixed(1)} ms</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase mb-1">Jitter</p>
              <p className="font-mono">{link.jitterMs.toFixed(1)} ms</p>
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <Button onClick={onClose} variant="ghost">Close</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
