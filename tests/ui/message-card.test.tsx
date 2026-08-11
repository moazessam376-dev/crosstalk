// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { MessageCard } from '../../src/ui/cards/MessageCard.js';

afterEach(cleanup);

/**
 * CT-16, in the operator's words: *"the agents are speaking in a very AI wayâ€¦
 * I want at least a preview on the message that is readable to a human,
 * something like Discord chat, with an expand button."*
 *
 * The ask is explicitly **not** that agents write less rigorously â€” the density
 * is the protocol working. It is that the hub not render every message at full
 * length in the stream. A 600-word claim with embedded evidence tables is
 * correct as an artefact and unreadable as a chat line. Measured on the live
 * hub: a 1327-character message rendered 250px tall with no control on it.
 */
const SHORT = 'metrics online (codex-app). Board is empty; awaiting T-01.';
const LONG = `Claim C-1 against the acceptance criterion for T-04. ${'The criterion says git diff --exit-code proves the manifest is byte-identical, and it does not. '.repeat(12)}`;

describe('a long message is previewed, not poured into the stream', () => {
  it('renders a short body whole, with no control on it', () => {
    render(createElement(MessageCard, { from: 'codex', body: SHORT }));

    expect(screen.getByText(SHORT)).toBeTruthy();
    expect(screen.queryByTestId('message-expand')).toBeNull();
  });

  it('collapses a long body and offers to expand it', () => {
    render(createElement(MessageCard, { from: 'leader', body: LONG, testId: 'card-long' }));

    const control = screen.getByTestId('message-expand');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('card-long').getAttribute('data-collapsed')).toBe('true');
  });

  it('expands when the control is used, and collapses again', () => {
    render(createElement(MessageCard, { from: 'leader', body: LONG, testId: 'card-long' }));
    const control = screen.getByTestId('message-expand');

    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('card-long').getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('card-long').getAttribute('data-collapsed')).toBe('true');
  });

  /**
   * What makes clamping honest rather than truncation. The body is clipped by
   * CSS, so every word stays in the DOM â€” selectable, findable by the browser's
   * own search, and readable by a screen reader. Passes against the unfixed
   * card too; it is here so a later "optimisation" to `body.slice(0, n)` turns
   * red.
   */
  it('keeps the whole text in the document in both states', () => {
    render(createElement(MessageCard, { from: 'leader', body: LONG, testId: 'card-long' }));
    const tail = LONG.trim().slice(-40);

    expect(screen.getByTestId('card-long').textContent).toContain(tail);
    fireEvent.click(screen.getByTestId('message-expand'));
    expect(screen.getByTestId('card-long').textContent).toContain(tail);
  });
});
