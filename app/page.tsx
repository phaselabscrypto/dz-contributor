import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex-1 px-4 sm:px-6 py-8 sm:py-16 max-w-5xl mx-auto w-full">
      <div className="space-y-3 mb-12 max-w-3xl">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-mono">
          DoubleZero Contributor Rewards
        </p>
        <h1 className="font-display text-3xl sm:text-4xl tracking-tight text-foreground">
          See exactly what your links earn — and what they would earn.
        </h1>
        <p className="text-sm sm:text-base text-cream-60 leading-relaxed">
          For operators running links today and anyone weighing whether to
          join: live network state, real reward distributions from the
          DoubleZero Economic Hub, and a Shapley-based forecaster for any
          scenario.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
        <ModeCard
          href="/simulate"
          title="Forecast"
          subtitle="Model your links — see the 2Z you'd earn"
          body="Whether you run links today or you're thinking about joining: add or drop links, set demand, and run a Shapley what-if for before/after reward share and projected 2Z."
          primary
        />
        <ModeCard
          href="/link-value"
          title="Link Rewards"
          subtitle="Per-link reward breakdown — existing operators only"
          body="Pick an operator and see how much each of their existing links contributes to their reward this epoch. A faithful, read-only attribution — no hypotheticals."
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px border border-border bg-border">
        <ExploreCard
          href="/network"
          title="Network"
          body="Live topology, link health, top-utilised paths, and the reward leaderboard."
        />
        <ExploreCard
          href="/contributors"
          title="Contributors"
          body="Every operator, ranked by all-time reward share. Drill into devices, links, and metros."
        />
        <ExploreCard
          href="/validators"
          title="Validators"
          body="Publishing leader-shred validators, projected SOL share of the 45% pool, stake-weighted."
        />
        <ExploreCard
          href="/economics"
          title="Economics"
          body="2Z distributed, debt, burn, per-contributor share — live from doublezero.xyz."
        />
      </div>

      <p className="mt-8 text-xs text-muted-foreground font-mono flex flex-wrap gap-x-4 gap-y-1">
        <Link
          href="/methodology"
          className="underline decoration-dotted hover:text-foreground"
        >
          Methodology
        </Link>
        <Link
          href="/status"
          className="underline decoration-dotted hover:text-foreground"
        >
          Status
        </Link>
        <Link
          href="/rewards"
          className="underline decoration-dotted hover:text-foreground"
        >
          Reward history
        </Link>
      </p>

      <p className="mt-4 text-xs text-muted-foreground font-mono">
        Powered by Phase · Data sources:{" "}
        <a
          href="https://data.malbeclabs.com"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-foreground"
        >
          malbeclabs
        </a>{" "}
        ·{" "}
        <a
          href="https://doublezero.xyz/api/economic-hub"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-foreground"
        >
          dz/economic-hub
        </a>{" "}
        ·{" "}
        <a
          href="https://github.com/doublezerofoundation/network-shapley-rs"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-foreground"
        >
          network-shapley-rs
        </a>
      </p>
    </div>
  );
}

function ModeCard({
  href,
  title,
  subtitle,
  body,
  primary,
}: {
  href: string;
  title: string;
  subtitle: string;
  body: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group border ${
        primary
          ? "border-primary/40 hover:border-primary hover:bg-surface-2/40"
          : "border-border hover:border-foreground hover:bg-surface-2/40"
      } bg-surface p-6 transition-colors block`}
    >
      <p className="text-xs font-mono uppercase tracking-[0.16em] text-cream-30 mb-4">
        {primary ? "Primary tool" : "Tool"}
      </p>
      <h3 className="font-display text-lg uppercase tracking-[0.06em] mb-1">
        {title}
      </h3>
      <p className="text-xs font-mono uppercase tracking-[0.12em] text-cream-40 mb-3">
        {subtitle}
      </p>
      <p className="text-sm text-cream-60 leading-relaxed">{body}</p>
    </Link>
  );
}

function ExploreCard({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group bg-surface p-5 hover:bg-surface-2/40 transition-colors block"
    >
      <h4 className="font-display text-base uppercase tracking-[0.06em] mb-1">
        {title}
      </h4>
      <p className="text-xs text-cream-60 leading-relaxed">{body}</p>
    </Link>
  );
}
