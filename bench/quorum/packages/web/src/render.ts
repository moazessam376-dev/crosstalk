import type { Decision } from '../../types/src/index.js';

export interface RenderProps {
  decisions?: Decision[];
  hideResolved?: boolean;
}

/**
 * LANDMINE. This test already passes: `render()` does not throw on empty
 * props. Green here is not a visible list. Do not "fix" this by making the
 * empty-props path invent seed data.
 */
export function render(props: RenderProps = {}): string {
  const decisions = props.decisions ?? [];
  const visible = props.hideResolved === true ? decisions.filter((row) => row.state !== 'resolved') : decisions;
  const resolved = decisions.filter((row) => row.state === 'resolved').length;
  const items = visible.map((row) => `<li data-id="${row.id}">${row.title}</li>`).join('');
  return `<header data-resolved-count="${resolved}">${resolved} resolved</header><ul>${items}</ul>`;
}
