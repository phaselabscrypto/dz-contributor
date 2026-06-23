import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "DZ Contributor Rewards";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Site-wide default OG card.
 *
 * Uses inline styles only — `next/og` runs in the Edge runtime with no
 * Tailwind. Phase brand: cream on near-black with the Phase wordmark.
 */
export default function OpenGraphImage() {
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
            gap: 16,
            fontSize: 22,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#fce184",
            opacity: 0.85,
          }}
        >
          DoubleZero · Contributor Rewards
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              fontWeight: 600,
            }}
          >
            See exactly what your links earn.
          </div>
          <div
            style={{
              fontSize: 28,
              maxWidth: 900,
              color: "#cdc6b0",
              lineHeight: 1.35,
            }}
          >
            Live network state, real on-chain reward distribution, and a
            Shapley-based forecaster for any add/remove scenario.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: 18,
            color: "#a39a82",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          <span>Powered by Phase</span>
          <span style={{ color: "#80d0ff" }}>dzcontributor.site</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
