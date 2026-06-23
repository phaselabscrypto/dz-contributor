"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NetworkPulse, NetworkPulseCompact } from "@/components/ui/network-pulse";
import { PhaseLockup } from "@/components/ui/phase-lockup";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export type SidebarItem = {
  href: string;
  label: string;
  group?: string;
};

const NAV: SidebarItem[] = [
  { href: "/network", label: "Network", group: "Overview" },
  { href: "/contributors", label: "Contributors", group: "Overview" },
  { href: "/validators", label: "Validators", group: "Overview" },
  { href: "/links", label: "Links", group: "Overview" },
  { href: "/simulate", label: "Forecast", group: "Tools" },
  { href: "/link-value", label: "Link Value-Add", group: "Tools" },
  { href: "/economics", label: "Economics", group: "Analysis" },
  { href: "/rewards", label: "Rewards", group: "Analysis" },
  { href: "/changelog", label: "Changelog", group: "Analysis" },
  { href: "/status", label: "Status", group: "Reference" },
  { href: "/methodology", label: "Methodology", group: "Reference" },
];

/**
 * Responsive shell:
 * - md+: persistent left sidebar
 * - <md: top bar with hamburger + slide-in drawer
 */
export function SidebarShell() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Drawer closes on navigation via the NavLink onClick handler below —
  // wired only in the mobile drawer so desktop is unaffected. The drawer
  // wrapper renders unconditionally on mobile; open/close transitions are
  // CSS-driven, so no "isClosing" tracker state is needed.

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        aria-label="Primary"
        className="hidden md:flex md:w-56 lg:w-60 shrink-0 flex-col border-r border-border bg-surface-2"
      >
        <SidebarHeader />
        <SidebarNav pathname={pathname} />
        <NetworkPulse />
        <SidebarFooter />
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
        <Link
          href="/network"
          className="font-wordmark text-base leading-none tracking-tight"
        >
          DZ CONTRIBUTOR
        </Link>
        <div className="flex items-center gap-2">
          <NetworkPulseCompact />
          <ThemeToggle />
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="size-9 border border-border flex items-center justify-center hover:bg-surface-2 transition-colors"
          >
            <Menu className="size-4" />
          </button>
        </div>
      </header>

      {/* Mobile drawer — always rendered on mobile; CSS classes drive the
           open/close transition. `pointer-events-none` when closed keeps
           the layer non-interactive without unmounting. */}
      <div
        className={`md:hidden fixed inset-0 z-50 flex ${
          open ? "pointer-events-auto" : "pointer-events-none"
        }`}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
      >
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={open ? 0 : -1}
            onClick={() => setOpen(false)}
            className={`flex-1 bg-background/80 backdrop-blur-sm transition-opacity duration-200 ${
              open ? "opacity-100" : "opacity-0"
            }`}
          />
          <aside
            className={`w-72 max-w-[85vw] bg-surface-2 border-l border-border flex flex-col transform transition-transform duration-200 ease-out ${
              open ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between px-5 py-5 border-b border-border">
              <div>
                <Link
                  href="/network"
                  onClick={() => setOpen(false)}
                  className="font-wordmark text-lg leading-none tracking-tight"
                >
                  DZ CONTRIBUTOR
                </Link>
                <div className="mt-1 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
                  Rewards
                </div>
              </div>
              <button
                type="button"
                aria-label="Close menu"
                tabIndex={open ? 0 : -1}
                onClick={() => setOpen(false)}
                className="size-9 border border-border flex items-center justify-center hover:bg-surface-3 transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>
            <SidebarNav pathname={pathname} onNavigate={() => setOpen(false)} />
            <NetworkPulse />
            <SidebarFooter />
          </aside>
        </div>
    </>
  );
}

function SidebarHeader() {
  return (
    <div className="px-5 py-5 border-b border-border flex items-start justify-between gap-2">
      <div>
        <Link
          href="/network"
          className="font-wordmark text-lg leading-none tracking-tight"
        >
          DZ CONTRIBUTOR
        </Link>
        <div className="mt-1 text-xs uppercase tracking-[0.14em] text-muted-foreground font-mono">
          Rewards
        </div>
      </div>
      <ThemeToggle />
    </div>
  );
}

const NAV_STATE_KEY = "dz-sidebar-open-groups-v1";
const DEFAULT_OPEN: Record<string, boolean> = {
  Overview: true,
  Tools: false,
  Analysis: false,
  Reference: false,
};

// useSyncExternalStore requires snapshot stability — returning a fresh
// object every call causes infinite re-renders. We cache the last parsed
// value keyed by the raw JSON string so identical localStorage state
// produces the same reference.
const storageCache = new Map<string, { raw: string | null; value: Record<string, boolean> | null }>();
function getStoredGroups(key: string): Record<string, boolean> | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  const cached = storageCache.get(key);
  if (cached && cached.raw === raw) return cached.value;
  let value: Record<string, boolean> | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      value = { ...DEFAULT_OPEN, ...parsed };
    } catch {
      value = null;
    }
  }
  storageCache.set(key, { raw, value });
  return value;
}

function subscribeToStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function SidebarNav({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  // Preserve NAV order — Object.entries on a built-from-scratch object
  // already respects insertion order, but defensively iterate NAV.
  const groups: { group: string; items: SidebarItem[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const item of NAV) {
    const key = item.group ?? "";
    let idx = groupIndex.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(key, idx);
      groups.push({ group: key, items: [] });
    }
    groups[idx].items.push(item);
  }

  // Which group does the current route live in? That one stays open
  // regardless of the persisted preference, so users never end up looking
  // at a sidebar that hides where they are.
  const activeGroup = groups.find((g) =>
    g.items.some(
      (item) =>
        pathname === item.href || pathname.startsWith(`${item.href}/`),
    ),
  )?.group;

  // Subscribe to the persisted "open groups" map via useSyncExternalStore.
  // This replaces a "useState + hydrate in useEffect" pattern that
  // triggered react-hooks/set-state-in-effect. The store reads
  // localStorage on every snapshot request, which React naturally
  // memoizes via referential equality on the returned object.
  const stored = useSyncExternalStore(
    subscribeToStorage,
    () => getStoredGroups(NAV_STATE_KEY),
    () => null, // SSR snapshot — defaults applied below
  );
  const open = stored ?? DEFAULT_OPEN;

  const toggle = (group: string) => {
    const next = { ...open, [group]: !open[group] };
    try {
      window.localStorage.setItem(NAV_STATE_KEY, JSON.stringify(next));
      // Notify other listeners (this tab) — `storage` event only fires
      // on OTHER tabs, so we dispatch a synthetic one for ourselves.
      window.dispatchEvent(new StorageEvent("storage", { key: NAV_STATE_KEY }));
    } catch {
      // Storage disabled / quota exceeded — toggle has no persisted effect.
    }
  };

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-3 text-sm">
      {groups.map(({ group, items }) => {
        // Ungrouped items render flat with no toggle.
        if (!group) {
          return (
            <ul key="__ungrouped" className="mb-4">
              {items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          );
        }
        const isOpen = open[group] ?? activeGroup === group;
        const isActiveGroup = activeGroup === group;
        return (
          <div key={group} className="mb-3">
            <button
              type="button"
              onClick={() => toggle(group)}
              aria-expanded={isOpen}
              className={cn(
                "w-full flex items-center justify-between px-3 py-1.5 text-xs uppercase tracking-[0.16em] font-mono transition-colors",
                isActiveGroup
                  ? "text-foreground/80"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{group}</span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-3 transition-transform",
                  isOpen ? "rotate-0" : "-rotate-90",
                )}
              />
            </button>
            {isOpen && (
              <ul className="mt-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: SidebarItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active =
    pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center px-3 py-2 text-sm border-l-2 -ml-px transition-colors",
          active
            ? "border-foreground text-foreground bg-surface-3"
            : "border-transparent text-muted-foreground hover:text-foreground hover:bg-surface-3/60",
        )}
      >
        {item.label}
      </Link>
    </li>
  );
}

function SidebarFooter() {
  return (
    <div className="border-t border-border">
      <PhaseLockup />
      <div className="px-5 py-2 text-xs text-muted-foreground font-mono uppercase tracking-[0.16em] flex items-center justify-between border-t border-border">
        <span>v0.3</span>
        <a
          href="https://github.com/phaselabscrypto/dz-contributor"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground transition-colors"
        >
          source
        </a>
      </div>
    </div>
  );
}
