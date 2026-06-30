import { ImageResponse } from "next/og";

// Dynamically-rendered social card (Open Graph + Twitter). Next serves this for
// both <meta og:image> and twitter:image, so a link shared on X / Slack / etc.
// unfurls with on-brand artwork instead of a bare URL. No static asset needed.
export const runtime = "edge";
export const alt = "Memento AI — People leave. Knowledge stays.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background:
            "radial-gradient(900px 500px at 50% -10%, #14223f 0%, #0a0b10 60%)",
          color: "#f3f5f9",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 40 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "linear-gradient(135deg, #a5f3fc, #2f7bf6)",
              display: "flex",
            }}
          />
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" }}>Memento AI</div>
        </div>
        <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.02, letterSpacing: "-0.03em", display: "flex", flexDirection: "column" }}>
          <span>People leave.</span>
          <span style={{ color: "#6ea6ff" }}>Knowledge stays.</span>
        </div>
        <div style={{ fontSize: 30, color: "#bfc6d4", marginTop: 36, maxWidth: 900, lineHeight: 1.4 }}>
          On-chain institutional memory. Every customer conversation, owned by your
          organization forever — on Sui &amp; Walrus.
        </div>
      </div>
    ),
    { ...size },
  );
}
