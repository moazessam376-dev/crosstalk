// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { MessageCard } from '../../src/ui/cards/MessageCard.js';

afterEach(cleanup);

/**
 * The card renders what the author wrote, not a guess at it.
 *
 * `MessageCard`'s own comment asked for this: a clip at 320 characters is the
 * reader's tooling guessing what mattered, and it recommended "a `summary`
 * field the *author* writes". `head` is that field.
 *
 * It also fixes a mismatch that was always there — the fold was decided on 320
 * *characters* in JS and drawn at four *lines* in CSS, so a 330-character body
 * that already fitted got a "Show more" button revealing nothing.
 */

const LONG = 'supporting detail, at length. '.repeat(20);

describe('a message with a head', () => {
  it('shows the head, and folds the body behind it', () => {
    render(createElement(MessageCard, {
      from: 'peer-1',
      head: 'wind sim lands, 14 tests green',
      body: LONG,
      tag: 'result',
    }));

    expect(screen.getByTestId('message-head')).toHaveTextContent('wind sim lands, 14 tests green');
    expect(screen.getByTestId('message-card')).toHaveAttribute('data-collapsed', 'true');

    fireEvent.click(screen.getByTestId('message-expand'));
    expect(screen.getByTestId('message-body')).toHaveTextContent('supporting detail');
  });

  it('offers no expander when the head is the whole message', () => {
    // The neighbouring case, and the one the old threshold got wrong: a button
    // that reveals nothing is worse than no button.
    render(createElement(MessageCard, {
      from: 'peer-1',
      head: 'taking the water and the boat',
      body: 'taking the water and the boat',
      tag: 'status',
    }));

    expect(screen.queryByTestId('message-expand')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-head')).toBeInTheDocument();
  });

  it('shows what kind of message it is', () => {
    render(createElement(MessageCard, { from: 'peer-1', head: 'who owns the HUD?', body: 'who owns the HUD?', tag: 'ask' }));

    expect(screen.getByTestId('message-tag')).toHaveTextContent('ask');
  });

  it('still renders a message written before any of this existed', () => {
    // 1187 events in the last run alone, none of them with a head.
    render(createElement(MessageCard, { from: '@human', body: LONG }));

    expect(screen.queryByTestId('message-head')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-tag')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-body')).toHaveTextContent('supporting detail');
    expect(screen.getByTestId('message-expand')).toBeInTheDocument();
  });
});
