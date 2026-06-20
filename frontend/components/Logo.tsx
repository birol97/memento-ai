// Memento AI — knowledge-graph mark: interconnected memory nodes forming a
// brain-like cluster. Electric-cyan gradient nodes + flowing connections.
export function Logo({ size = 28 }: { size?: number }) {
  const nodes: [number, number, number][] = [
    [20, 22, 2.6],
    [32, 14, 3],
    [45, 22, 2.6],
    [15, 36, 2.2],
    [31, 31, 4],   // hub
    [48, 37, 2.8],
    [24, 48, 2.6],
    [40, 48, 2.2],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [0, 4], [1, 4], [2, 5], [3, 4],
    [4, 5], [3, 6], [4, 6], [4, 7], [5, 7], [6, 7], [0, 3],
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label="Memento AI">
      <defs>
        <linearGradient id="memNode" x1="12" y1="10" x2="52" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a5f3fc" />
          <stop offset="0.5" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0891b2" />
        </linearGradient>
      </defs>
      {/* connections */}
      <g stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1.4" strokeLinecap="round">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} />
        ))}
      </g>
      {/* hub halo */}
      <circle cx={nodes[4][0]} cy={nodes[4][1]} r="8" fill="#22d3ee" opacity="0.16" />
      {/* nodes */}
      <g fill="url(#memNode)">
        {nodes.map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} />
        ))}
      </g>
    </svg>
  );
}
