"use client";

// A messenger-style round avatar: initials on a color derived from the name,
// so every customer gets a stable, recognizable chip in the inbox + chat header.
const AV_COLORS = ["#5b9dff", "#a3e635", "#f59e0b", "#f472b6", "#22d3ee", "#c084fc", "#34d399", "#fb7185"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "");
  return s.toUpperCase() || "?";
}

function avColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      className="cw-avatar"
      style={{ width: size, height: size, background: avColor(name), fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}
