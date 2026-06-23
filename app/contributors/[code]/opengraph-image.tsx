import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import {
  ECONOMIC_HUB_NAME_TO_CODE,
  CONTRIBUTOR_NAMES,
  CONTRIBUTOR_COLORS,
} from "@/lib/constants/config";

export const alt = "Contributor on DoubleZero";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface EconomicHubResponse {
  totalDistributed2Z: number;
  totalDistributed2ZUsd: number;
  contributors: Array<{ name: string; rewardPercentage: number }>;
}

function ehNameToCode(name: string): string {
  return (
    ECONOMIC_HUB_NAME_TO_CODE[name] ?? name.toLowerCase().replace(/\s+/g, "")
  );
}

async function fetchHub(): Promise<EconomicHubResponse | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? "https";
    if (!host) return null;
    const res = await fetch(`${proto}://${host}/api/live/economic-hub`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as EconomicHubResponse;
  } catch {
    return null;
  }
}

export default async function ContributorOG({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const displayName = CONTRIBUTOR_NAMES[code] ?? code;
  const accent = CONTRIBUTOR_COLORS[code] ?? "#f3eed9";

  const hub = await fetchHub();
  const ehMatch = hub?.contributors.find((c) => ehNameToCode(c.name) === code);
  const sharePct = ehMatch?.rewardPercentage ?? 0;
  const earned2Z = hub ? (sharePct / 100) * hub.totalDistributed2Z : 0;
  const earnedUsd = hub ? (sharePct / 100) * hub.totalDistributed2ZUsd : 0;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background:
            "radial-gradient(ellipse at top left, #1a1815 0%, #0f0c0e 60%)",
          color: "#f3eed9",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 22,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#a39a82",
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 9999,
              background: accent,
              display: "inline-block",
            }}
          />
          DoubleZero · Contributor
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontSize: 96,
              lineHeight: 1.0,
              letterSpacing: "-0.02em",
              fontWeight: 600,
              color: "#f3eed9",
            }}
          >
            {displayName}
          </div>
          <div
            style={{
              fontSize: 22,
              fontFamily: "ui-monospace, monospace",
              color: "#80d0ff",
              letterSpacing: "0.06em",
            }}
          >
            {code}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 48,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                fontSize: 16,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "#a39a82",
              }}
            >
              All-time reward share
            </div>
            <div
              style={{
                fontSize: 64,
                fontFamily: "ui-monospace, monospace",
                color: accent,
                lineHeight: 1.0,
              }}
            >
              {sharePct > 0 ? `${sharePct.toFixed(2)}%` : "—"}
            </div>
          </div>

          {earned2Z > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                style={{
                  fontSize: 16,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "#a39a82",
                }}
              >
                2Z earned
              </div>
              <div
                style={{
                  fontSize: 36,
                  fontFamily: "ui-monospace, monospace",
                  lineHeight: 1.0,
                }}
              >
                {Math.round(earned2Z).toLocaleString()}
              </div>
            </div>
          )}

          {earnedUsd > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                style={{
                  fontSize: 16,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "#a39a82",
                }}
              >
                USD value
              </div>
              <div
                style={{
                  fontSize: 36,
                  fontFamily: "ui-monospace, monospace",
                  lineHeight: 1.0,
                  color: "#fce184",
                }}
              >
                ${Math.round(earnedUsd).toLocaleString()}
              </div>
            </div>
          )}

          <div
            style={{
              marginLeft: "auto",
              fontSize: 14,
              color: "#a39a82",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            Powered by Phase
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
