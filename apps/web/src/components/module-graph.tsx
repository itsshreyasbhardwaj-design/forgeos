'use client';

import { useMemo, useState } from 'react';
import type { ModuleGraph as GraphData } from '@forgeos/core';

/**
 * An interactive module-graph renderer.
 *
 * Deliberately hand-rolled rather than delegated to a graph library. The layout
 * ForgeOS wants is not a force simulation — those produce a hairball that moves
 * every time you open it. It is a *layered* layout: modules are placed in
 * columns by dependency depth, which makes direction of dependency readable at
 * a glance and, critically, is deterministic. The same repository always draws
 * the same picture, so two people can talk about "the node on the left".
 */
interface Positioned {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly layer: string | null;
}

const LAYER_COLORS: Record<string, string> = {
  presentation: 'var(--forge-accent)',
  interface: 'var(--forge-info)',
  application: 'var(--forge-success)',
  domain: 'var(--forge-warning)',
  persistence: 'var(--forge-high)',
  shared: 'var(--forge-text-subtle)',
  configuration: 'var(--forge-low)',
  operations: 'var(--forge-moderate)',
  test: 'var(--forge-text-subtle)',
};

const NODE_WIDTH = 150;
const NODE_HEIGHT = 30;
const COLUMN_GAP = 210;
const ROW_GAP = 44;

function computeLayout(graph: GraphData, maxNodes: number): {
  nodes: Positioned[];
  edges: { from: string; to: string }[];
  width: number;
  height: number;
} {
  const ranked = [...graph.nodes]
    .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || b.loc - a.loc)
    .slice(0, maxNodes);
  const kept = new Set(ranked.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => kept.has(edge.from) && kept.has(edge.to) && edge.from !== edge.to)
    .map((edge) => ({ from: edge.from, to: edge.to }));

  // Depth = longest path from a root, computed iteratively with a visit cap so
  // a cyclic graph terminates instead of recursing forever.
  const dependencies = new Map<string, string[]>();
  for (const edge of edges) {
    const bucket = dependencies.get(edge.from) ?? [];
    bucket.push(edge.to);
    dependencies.set(edge.from, bucket);
  }

  const depths = new Map<string, number>();
  for (const node of ranked) depths.set(node.id, 0);

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const edge of edges) {
      const next = (depths.get(edge.from) ?? 0) + 1;
      if (next > (depths.get(edge.to) ?? 0) && next < 12) {
        depths.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, typeof ranked>();
  for (const node of ranked) {
    const depth = depths.get(node.id) ?? 0;
    const bucket = columns.get(depth) ?? [];
    bucket.push(node);
    columns.set(depth, bucket);
  }

  const nodes: Positioned[] = [];
  let maxRows = 0;

  for (const [depth, columnNodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...columnNodes].sort((a, b) => b.fanIn - a.fanIn || a.label.localeCompare(b.label));
    maxRows = Math.max(maxRows, sorted.length);
    sorted.forEach((node, index) => {
      nodes.push({
        id: node.id,
        label: node.label,
        x: 30 + depth * COLUMN_GAP,
        y: 30 + index * ROW_GAP,
        depth,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        layer: node.layer,
      });
    });
  }

  return {
    nodes,
    edges,
    width: 60 + Math.max(1, columns.size) * COLUMN_GAP,
    height: 60 + maxRows * ROW_GAP,
  };
}

export function ModuleGraphView({
  graph,
  maxNodes = 48,
}: {
  graph: GraphData;
  maxNodes?: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => computeLayout(graph, maxNodes), [graph, maxNodes]);
  const positions = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes]
  );

  if (layout.nodes.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-[13px] text-[var(--forge-text-muted)]">
        No module relationships were resolved for this repository.
      </p>
    );
  }

  // Highlight the hovered node's immediate neighbourhood; everything else fades.
  const connected = new Set<string>();
  if (hovered) {
    connected.add(hovered);
    for (const edge of layout.edges) {
      if (edge.from === hovered) connected.add(edge.to);
      if (edge.to === hovered) connected.add(edge.from);
    }
  }

  return (
    <div className="overflow-auto rounded-[var(--forge-radius-lg)] border border-[var(--forge-border)] bg-[var(--forge-bg-subtle)]">
      <svg
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={`Module graph with ${layout.nodes.length} modules and ${layout.edges.length} dependencies`}
      >
        <defs>
          <marker
            id="forge-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--forge-border-strong)" />
          </marker>
        </defs>

        {layout.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;

          const startX = from.x + NODE_WIDTH;
          const startY = from.y + NODE_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + NODE_HEIGHT / 2;
          const midX = (startX + endX) / 2;
          const dim = hovered !== null && !(connected.has(edge.from) && connected.has(edge.to));

          return (
            <path
              key={`${edge.from}-${edge.to}-${index}`}
              d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
              fill="none"
              stroke="var(--forge-border-strong)"
              strokeWidth={dim ? 0.6 : 1.2}
              opacity={dim ? 0.2 : 0.75}
              markerEnd="url(#forge-arrow)"
            />
          );
        })}

        {layout.nodes.map((node) => {
          const dim = hovered !== null && !connected.has(node.id);
          const colour = node.layer ? (LAYER_COLORS[node.layer] ?? 'var(--forge-accent)') : 'var(--forge-text-subtle)';

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              opacity={dim ? 0.28 : 1}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer', transition: 'opacity 150ms' }}
            >
              <title>{`${node.id}\n${node.fanIn} dependents · ${node.fanOut} dependencies${node.layer ? ` · ${node.layer}` : ''}`}</title>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={7}
                fill="var(--forge-surface)"
                stroke={hovered === node.id ? colour : 'var(--forge-border)'}
                strokeWidth={hovered === node.id ? 2 : 1}
              />
              <rect width={3} height={NODE_HEIGHT} rx={1.5} fill={colour} />
              <text
                x={12}
                y={NODE_HEIGHT / 2 + 4}
                fontSize={11}
                fill="var(--forge-text)"
                fontFamily="var(--forge-font-mono)"
              >
                {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Legend for the layer colours used above. */
export function LayerLegend({ layers }: { layers: readonly string[] }) {
  if (layers.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--forge-text-muted)]">
      {layers.map((layer) => (
        <span key={layer} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: LAYER_COLORS[layer] ?? 'var(--forge-text-subtle)' }}
          />
          {layer}
        </span>
      ))}
    </div>
  );
}
