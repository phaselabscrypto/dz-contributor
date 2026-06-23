"use client";

import { useMemo } from "react";
import { useSnapshot } from "./use-snapshot";
import type { Link } from "@/lib/types/contributor";

export function useLinks(epoch: number | null) {
  const { data: snapshot, isLoading, error } = useSnapshot(epoch);

  const links = useMemo(() => {
    if (!snapshot) return [];

    // Flatten all links from all contributors
    const allLinks: (Link & { pubkey: string })[] = [];
    snapshot.contributors.forEach((contrib) => {
      contrib.links.forEach((link) => {
        allLinks.push({
          ...link,
          pubkey: link.pubkey,
        });
      });
    });

    return allLinks;
  }, [snapshot]);

  return {
    links,
    isLoading,
    error,
  };
}
