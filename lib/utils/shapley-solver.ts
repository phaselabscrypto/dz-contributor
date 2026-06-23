import type { ShapleyInput, ShapleyOutput } from "@/lib/types/shapley";

// --- Graph types ---
//
// We model the network as a directed graph where every edge has a residual
// capacity (Gbps). Public-internet edges are uncapped (Infinity) and incur a
// contiguity penalty when mixed with private edges, mirroring the canonical
// Python/Rust algorithm. This lets coalition value reflect bandwidth scarcity:
// a coalition that adds a wide link on a hot corridor unlocks more demand
// than one with the same hop count but a narrow pipe.

interface GraphEdge {
  id: number;        // index into the edge pool (used to debit residual)
  target: string;
  latency: number;
  capacity: number;  // remaining capacity in Gbps; Infinity for public links
  isPublic: boolean;
}

interface Graph {
  /** adjacency list keyed by source node */
  adj: Map<string, GraphEdge[]>;
  /** parallel residual capacity store, indexed by edge id */
  residual: Float64Array;
}

// --- Bit manipulation helpers ---

function popcount(n: number): number {
  let count = 0;
  while (n) {
    count += n & 1;
    n >>>= 1;
  }
  return count;
}

function precomputeFactorials(n: number): Float64Array {
  const f = new Float64Array(n + 1);
  f[0] = 1;
  for (let i = 1; i <= n; i++) {
    f[i] = f[i - 1] * i;
  }
  return f;
}

// --- Metro code extraction ---

// --- Graph construction ---

function buildCoalitionGraph(
  input: ShapleyInput,
  operators: string[],
  coalitionMask: number
): Graph {
  const adj: Map<string, GraphEdge[]> = new Map();
  const capacities: number[] = [];

  const activeOps = new Set<string>();
  for (let i = 0; i < operators.length; i++) {
    if (coalitionMask & (1 << i)) {
      activeOps.add(operators[i]);
    }
  }

  const addEdge = (
    from: string,
    to: string,
    latency: number,
    capacity: number,
    isPublic: boolean,
  ) => {
    const id = capacities.length;
    capacities.push(capacity);
    let edges = adj.get(from);
    if (!edges) {
      edges = [];
      adj.set(from, edges);
    }
    edges.push({ id, target: to, latency, capacity, isPublic });
  };

  // Build device→operator map for this input
  const deviceOps = new Map<string, Set<string>>();
  for (const d of input.devices) {
    let ops = deviceOps.get(d.device);
    if (!ops) {
      ops = new Set();
      deviceOps.set(d.device, ops);
    }
    ops.add(d.operator);
  }

  // Private links: both endpoints must have at least one active operator.
  // Each private link gets a finite capacity in Gbps; we model bidirectional
  // traffic as two separate edges sharing the same nominal capacity (the
  // canonical algorithm treats links as full-duplex, so this matches).
  for (const link of input.private_links) {
    const ops1 = deviceOps.get(link.device1);
    const ops2 = deviceOps.get(link.device2);
    const hasActive1 = ops1 && [...ops1].some((op) => activeOps.has(op));
    const hasActive2 = ops2 && [...ops2].some((op) => activeOps.has(op));
    if (hasActive1 && hasActive2) {
      const cap = Math.max(0, link.bandwidth);
      addEdge(link.device1, link.device2, link.latency, cap, false);
      addEdge(link.device2, link.device1, link.latency, cap, false);
    }
  }

  // Public links: always available, infinite capacity (internet baseline).
  for (const link of input.public_links) {
    addEdge(link.city1, link.city2, link.latency, Infinity, true);
    addEdge(link.city2, link.city1, link.latency, Infinity, true);
  }

  return { adj, residual: Float64Array.from(capacities) };
}

// --- Dijkstra shortest path with capacity + contiguity bonus ---
//
// Returns the path from `start` to `end` whose accumulated latency is
// minimal subject to: every edge on the path has residual >= demandTraffic.
// When a path mixes private and public edges, we add `contiguityBonus` ms
// per crossover (matches the Python reference's contiguity semantics).
//
// Returns null if no feasible path exists.

interface RoutedPath {
  latency: number;
  edgeIds: number[];
}

function shortestPathWithCapacity(
  graph: Graph,
  start: string,
  end: string,
  demandTraffic: number,
  contiguityBonus: number,
): RoutedPath | null {
  if (start === end) return { latency: 0, edgeIds: [] };

  // State per node: best (latency, lastEdgeWasPublic).
  // We track whether the last edge crossed was public so we can charge a
  // contiguity bonus on private↔public transitions without re-exploring.
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edgeId: number }>();
  const lastWasPublic = new Map<string, boolean | null>();
  dist.set(start, 0);
  lastWasPublic.set(start, null);

  // Min-heap implemented as sorted-on-insert array — graphs here are <100 nodes.
  const pq: Array<{ d: number; node: string }> = [{ d: 0, node: start }];

  while (pq.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].d < pq[minIdx].d) minIdx = i;
    }
    const { d, node } = pq[minIdx];
    pq[minIdx] = pq[pq.length - 1];
    pq.pop();

    if (node === end) break;
    if (d > (dist.get(node) ?? Infinity)) continue;

    const edges = graph.adj.get(node);
    if (!edges) continue;
    const wasPublic = lastWasPublic.get(node) ?? null;

    for (const edge of edges) {
      // Skip edges that can't carry the demand
      if (graph.residual[edge.id] < demandTraffic) continue;

      // Apply contiguity bonus when transitioning between private/public
      let cost = edge.latency;
      if (wasPublic !== null && wasPublic !== edge.isPublic) {
        cost += contiguityBonus;
      }
      const newDist = d + cost;
      const known = dist.get(edge.target);
      if (known === undefined || newDist < known) {
        dist.set(edge.target, newDist);
        prev.set(edge.target, { node, edgeId: edge.id });
        lastWasPublic.set(edge.target, edge.isPublic);
        pq.push({ d: newDist, node: edge.target });
      }
    }
  }

  const total = dist.get(end);
  if (total === undefined) return null;

  // Reconstruct path
  const edgeIds: number[] = [];
  let cur = end;
  while (cur !== start) {
    const step = prev.get(cur);
    if (!step) return null;
    edgeIds.push(step.edgeId);
    cur = step.node;
  }
  edgeIds.reverse();
  return { latency: total, edgeIds };
}

// --- Helper: route a path and debit residual capacity ---

function routeAndDebit(
  graph: Graph,
  edgeIds: number[],
  traffic: number
): void {
  for (const edgeId of edgeIds) {
    graph.residual[edgeId] = Math.max(0, graph.residual[edgeId] - traffic);
  }
}

// --- Coalition value function (greedy flow-based demand packing) ---

function evaluateCoalition(
  input: ShapleyInput,
  operators: string[],
  coalitionMask: number
): number {
  if (coalitionMask === 0) return 0;

  const graph = buildCoalitionGraph(input, operators, coalitionMask);

  // Sort demands by priority (descending) for greedy packing.
  // Higher priority demands get routed first, ensuring best-effort allocation.
  const sortedDemands = [...input.demands].sort((a, b) => b.priority - a.priority);

  let totalValue = 0;
  for (const demand of sortedDemands) {
    // Find shortest path that can carry this demand's traffic
    const path = shortestPathWithCapacity(
      graph,
      demand.start,
      demand.end,
      demand.traffic,
      10 // contiguity bonus: 10ms per private↔public crossing
    );

    if (path === null) continue; // demand cannot be routed

    // Debit residual capacity along the path
    routeAndDebit(graph, path.edgeIds, demand.traffic);

    // Value inversely proportional to latency, scaled by demand size
    const demandValue =
      (demand.traffic * demand.priority * demand.receivers) /
      (1 + path.latency);

    totalValue += demandValue;
  }

  return totalValue * input.demand_multiplier;
}

// --- Uptime adjustment ---

function applyUptime(
  coalitionValues: Float64Array,
  n: number,
  uptime: number
): Float64Array {
  const clampedUptime = Math.max(0, Math.min(1, uptime));
  if (clampedUptime >= 0.9999) return coalitionValues;

  const nCoalitions = 1 << n;
  const expected = new Float64Array(nCoalitions);

  for (let S = 0; S < nCoalitions; S++) {
    let ev = 0;
    const sizeS = popcount(S);

    // Iterate over all subsets T of S (including empty set)
    // Using Gosper's trick for subset enumeration
    let T = S;
    while (T > 0) {
      const sizeT = popcount(T);
      const prob =
        Math.pow(clampedUptime, sizeT) * Math.pow(1 - clampedUptime, sizeS - sizeT);
      ev += prob * coalitionValues[T];
      T = (T - 1) & S;
    }
    // Empty subset (T=0)
    ev += Math.pow(1 - uptime, sizeS) * coalitionValues[0];

    expected[S] = ev;
  }

  return expected;
}

// --- Main Shapley computation ---

export function computeShapley(input: ShapleyInput): ShapleyOutput {
  const operatorSet = new Set<string>();
  for (const d of input.devices) {
    operatorSet.add(d.operator);
  }
  const operators = Array.from(operatorSet).sort();
  const n = operators.length;

  if (n === 0) return {};
  if (n > 20) {
    // Safety: 2^20 = 1M coalitions, anything beyond is too expensive
    throw new Error(`Too many operators (${n}) for exact Shapley computation`);
  }

  const nCoalitions = 1 << n;

  // Evaluate all coalitions
  const coalitionValues = new Float64Array(nCoalitions);
  for (let mask = 0; mask < nCoalitions; mask++) {
    coalitionValues[mask] = evaluateCoalition(input, operators, mask);
  }

  // Apply uptime adjustment
  const expectedValues = applyUptime(
    coalitionValues,
    n,
    input.operator_uptime
  );

  // Compute Shapley values
  const factorials = precomputeFactorials(n);
  const shapleyValues = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let value = 0;
    for (let mask = 0; mask < nCoalitions; mask++) {
      if (!(mask & (1 << i))) continue; // operator i not in coalition
      const withoutOp = mask ^ (1 << i);
      const sizeS = popcount(mask);
      const weight =
        (factorials[sizeS - 1] * factorials[n - sizeS]) / factorials[n];
      value += weight * (expectedValues[mask] - expectedValues[withoutOp]);
    }
    shapleyValues[i] = value;
  }

  // Normalize to shares
  const totalValue = shapleyValues.reduce((a, b) => a + b, 0);
  const output: ShapleyOutput = {};
  for (let i = 0; i < n; i++) {
    output[operators[i]] = {
      value: shapleyValues[i],
      share: totalValue > 0 ? shapleyValues[i] / totalValue : 0,
    };
  }

  return output;
}
