import { createElement as h } from 'react';
import { harnessKind } from './kind.js';


/**
 * The mark of the CLI behind a seat.
 *
 * Seats used to be told apart by a colour drawn from a palette, which carried
 * no information: the colour said "this is a different participant", when the
 * fact worth reading at a glance is *which tool is answering*. A run mixing
 * Claude Code, Codex and Cursor is the normal case, and the harness is what
 * explains a seat's behaviour when it surprises you.
 *
 * These are the vendors' own marks, used to identify their products — the same
 * nominative use any multi-model client makes. They are drawn rather than
 * fetched because the hub is served from a daemon with no network egress.
 *
 * Every stroke is `currentColor`. The brand colour is set in `theme.css` off
 * the `data-harness` attribute each mark carries, which keeps the palette in
 * one file and lets a mark inherit the muted tone of whatever row it sits in
 * without this component knowing anything about rows.
 */
export { harnessKind, type HarnessKind } from './kind.js';

/** Twelve tapered spokes from a dense centre. Lengths vary, as the mark does. */
function claudeSpokes(): string[] {
  const lengths = [9.4, 9.0, 9.5, 8.8, 9.2, 8.6, 9.3, 9.0, 9.5, 8.7, 9.1, 8.8];
  return lengths.map((r, index) => {
    const angle = (index * 30 * Math.PI) / 180;
    const x = 12 + r * Math.sin(angle);
    const y = 12 - r * Math.cos(angle);
    return `M12 12L${x.toFixed(1)} ${y.toFixed(1)}`;
  });
}

/** The scalloped blossom: eight nodes joined by outward arcs. */
function codexBlossom(): string {
  const nodes: Array<[number, number]> = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index * 45 * Math.PI) / 180;
    nodes.push([12 + 7.4 * Math.sin(angle), 12 - 7.4 * Math.cos(angle)]);
  }
  let path = `M${nodes[0]![0].toFixed(1)} ${nodes[0]![1].toFixed(1)}`;
  for (let index = 1; index <= 8; index += 1) {
    const [x, y] = nodes[index % 8]!;
    path += `A3.2 3.2 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${path}Z`;
}

function cursorCube(): { hex: string; spokes: string } {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = (index * 60 * Math.PI) / 180;
    points.push([12 + 8.4 * Math.sin(angle), 12 - 8.4 * Math.cos(angle)]);
  }
  const hex = `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;
  const spokes = [0, 2, 4]
    .map((index) => `M12 12L${points[index]![0].toFixed(1)} ${points[index]![1].toFixed(1)}`)
    .join('');
  return { hex, spokes };
}

export interface HarnessMarkProps {
  harness?: string;
  size?: number;
  /** Rendered in place of a vendor mark when the harness is not one we know. */
  fallback?: string;
}

export function HarnessMark({ harness, size = 14, fallback }: HarnessMarkProps) {
  const kind = harnessKind(harness);
  const svg = (children: ReturnType<typeof h>[]) =>
    h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        className: 'harness-mark',
        'data-harness': kind,
      },
      ...children,
    );

  if (kind === 'claude') {
    return svg([
      h(
        'g',
        {
          key: 'spokes',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
        },
        claudeSpokes().map((d, index) => h('path', { key: index, d })),
      ),
    ]);
  }

  if (kind === 'codex') {
    return svg([
      h('path', {
        key: 'blossom',
        d: codexBlossom(),
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinejoin: 'round',
      }),
      h('path', {
        key: 'caret',
        d: 'M9.6 9.9 12.1 12l-2.5 2.1',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      h('path', {
        key: 'rule',
        d: 'M13.4 14.4h2.9',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
      }),
    ]);
  }

  if (kind === 'human') {
    // A person, not a product. Deliberately the plainest mark here: it must
    // read instantly as "this one is you" beside three vendor logos.
    return svg([
      h('circle', { key: 'head', cx: 12, cy: 9, r: 3.6, stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', {
        key: 'shoulders',
        d: 'M5.4 19.4a6.6 6.6 0 0 1 13.2 0',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
      }),
    ]);
  }

  if (kind === 'cursor') {
    const { hex, spokes } = cursorCube();
    return svg([
      h('path', { key: 'hex', d: hex, stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
      h('path', { key: 'spokes', d: spokes, stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
    ]);
  }

  // A seat on a harness we have no mark for still needs to be told apart, so
  // it keeps its initials rather than rendering an empty box.
  return h(
    'span',
    { className: 'harness-mark-fallback', 'data-harness': 'unknown' },
    fallback ?? '··',
  );
}
