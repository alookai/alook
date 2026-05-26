import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

export type LayoutType = "star" | "tree" | "flow";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 100;

export function getAutoLayout(
  nodes: Node[],
  edges: Edge[],
  layout: LayoutType = "tree",
): Node[] {
  if (nodes.length === 0) return nodes;

  switch (layout) {
    case "star":
      return getConcentricLayout(nodes, edges);
    case "tree":
      return getDagreLayout(nodes, edges, "TB");
    case "flow":
      return getDagreLayout(nodes, edges, "LR");
  }
}

function getDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB",
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 80,
    ranksep: 180,
    marginx: 40,
    marginy: 40,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

function getConcentricLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 1) {
    return [{ ...nodes[0], position: { x: -NODE_WIDTH / 2, y: -NODE_HEIGHT / 2 } }];
  }

  const degree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const adjacency: Record<string, Set<string>> = {};

  for (const node of nodes) {
    degree[node.id] = 0;
    outDegree[node.id] = 0;
    adjacency[node.id] = new Set();
  }

  for (const edge of edges) {
    if (degree[edge.source] !== undefined && degree[edge.target] !== undefined) {
      degree[edge.source]++;
      degree[edge.target]++;
      outDegree[edge.source]++;
      adjacency[edge.source].add(edge.target);
      adjacency[edge.target].add(edge.source);
    }
  }

  const sortedNodes = [...nodes].sort((a, b) => {
    const degDiff = (degree[b.id] ?? 0) - (degree[a.id] ?? 0);
    if (degDiff !== 0) return degDiff;
    const outDiff = (outDegree[b.id] ?? 0) - (outDegree[a.id] ?? 0);
    if (outDiff !== 0) return outDiff;
    return a.id.localeCompare(b.id);
  });

  const centerId = sortedNodes[0].id;
  const centerNeighbors = adjacency[centerId] ?? new Set();

  const firstRing: Node[] = [];
  const outerRing: Node[] = [];

  for (const node of nodes) {
    if (node.id === centerId) continue;
    if (centerNeighbors.has(node.id)) {
      firstRing.push(node);
    } else {
      outerRing.push(node);
    }
  }

  const FIRST_RADIUS = 250;
  const OUTER_RADIUS = 450;

  const positioned: Record<string, { x: number; y: number }> = {};
  positioned[centerId] = { x: -NODE_WIDTH / 2, y: -NODE_HEIGHT / 2 };

  for (let i = 0; i < firstRing.length; i++) {
    const angle = (2 * Math.PI * i) / firstRing.length - Math.PI / 2;
    positioned[firstRing[i].id] = {
      x: Math.cos(angle) * FIRST_RADIUS - NODE_WIDTH / 2,
      y: Math.sin(angle) * FIRST_RADIUS - NODE_HEIGHT / 2,
    };
  }

  for (let i = 0; i < outerRing.length; i++) {
    const angle = (2 * Math.PI * i) / outerRing.length - Math.PI / 2;
    positioned[outerRing[i].id] = {
      x: Math.cos(angle) * OUTER_RADIUS - NODE_WIDTH / 2,
      y: Math.sin(angle) * OUTER_RADIUS - NODE_HEIGHT / 2,
    };
  }

  return nodes.map((node) => ({
    ...node,
    position: positioned[node.id] ?? { x: 0, y: 0 },
  }));
}
