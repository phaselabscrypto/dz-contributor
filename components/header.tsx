"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";

const NAV_ITEMS = [
  { value: "network", label: "Network" },
  { value: "contributors", label: "Contributors" },
  { value: "simulate", label: "Simulate" },
  { value: "validators", label: "Validators" },
  { value: "economics", label: "Economics" },
];

interface HeaderProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function Header({ activeTab, onTabChange }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-cream-8 bg-dark px-4 sm:px-6 py-3">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl tracking-wide text-cream">
            DZ CONTRIBUTOR
          </h1>
          <span className="text-cream-20">|</span>
          <span className="font-body text-sm text-cream-40">
            Rewards
          </span>
        </div>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-6">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.value}
              onClick={() => onTabChange(item.value)}
              className={`text-sm transition-colors rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                activeTab === item.value
                  ? "text-cream"
                  : "text-cream-40 hover:text-cream"
              }`}
            >
              {item.label}
            </button>
          ))}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-5 border border-cream-8 px-3 py-1 text-xs text-cream-60">
            <span className="h-1.5 w-1.5 rounded-full bg-green" />
            Live
          </span>
        </nav>

        {/* Mobile hamburger */}
        <div className="flex items-center gap-3 sm:hidden">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-cream-5 border border-cream-8 px-3 py-1 text-xs text-cream-60">
            <span className="h-1.5 w-1.5 rounded-full bg-green" />
            Live
          </span>
          <button
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen(!menuOpen)}
            className="text-cream-40 hover:text-cream focus-visible:ring-2 focus-visible:ring-cream-20 rounded-md transition-colors p-1"
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {menuOpen && (
        <nav className="sm:hidden mt-3 pb-1 border-t border-cream-8 pt-3 flex flex-col">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.value}
              onClick={() => {
                onTabChange(item.value);
                setMenuOpen(false);
              }}
              className={`text-sm transition-colors py-2 text-left rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                activeTab === item.value
                  ? "text-cream"
                  : "text-cream-40 hover:text-cream"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
