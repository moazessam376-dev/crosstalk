import { createElement } from 'react';

export interface DisconnectedProps {
  /** Why the daemon did not answer. Carried through, never swallowed. */
  reason: string;
  /** What the browser is pointed at, so the missing token is visible. */
  origin: string;
  /** How many sample events loaded. Zero means there is no sample to offer. */
  sampleCount: number;
  onViewSample?: () => void;
}

/**
 * What a hub with no daemon shows instead of a hub.
 *
 * CT-10: a refused browser used to get the whole working chrome — channel list,
 * composer, `POST /events`, a live Send button — over `0 events` and an empty
 * participants panel, above the words "showing a sample conversation" when no
 * sample had loaded. An operator read a live session holding sixteen events and
 * two open claims, one a blocker, as "nothing is on the hub from my end".
 *
 * Two things were wrong and only one of them was the text. The status string
 * described content that was not on the screen, and every control still looked
 * operational — the refusal was restated only *after* you typed and pressed
 * send. A dead hub must not present a working keyboard.
 *
 * So: no sidebar, no dock, no composer. The recovery instruction and the URL,
 * and the sample offered only when one actually exists — a link that says
 * "sample" and then shows nothing is the original defect wearing a button.
 */
export function Disconnected({ reason, origin, sampleCount, onViewSample }: DisconnectedProps) {
  return createElement(
    'main',
    { className: 'disconnected', 'data-testid': 'disconnected', role: 'main' },
    createElement(
      'div',
      { className: 'disconnected-card' },
      createElement('span', { className: 'disconnected-eyebrow' }, 'NOT CONNECTED'),
      createElement('h1', { className: 'disconnected-title' }, 'This hub is not showing your session.'),
      createElement('p', { className: 'disconnected-reason', 'data-testid': 'disconnected-reason' }, reason),
      createElement(
        'div',
        { className: 'disconnected-what' },
        createElement('span', { className: 'fact-label' }, 'you opened'),
        createElement('p', { className: 'fact disconnected-origin', 'data-testid': 'disconnected-origin' }, origin),
      ),
      createElement(
        'div',
        { className: 'disconnected-what' },
        createElement('span', { className: 'fact-label' }, 'to fix it'),
        createElement(
          'p',
          null,
          'Open the tokenised link ',
          createElement('span', { className: 'fact' }, 'crosstalk up'),
          ' printed. It ends in ',
          createElement('span', { className: 'fact' }, '?t=…'),
          ' and sets the cookie this page needs. The bare origin your browser autocompletes will not.',
        ),
      ),
      createElement(
        'p',
        { className: 'disconnected-note' },
        'Your session is unaffected — the event log on disk is the source of truth, and nothing here has been lost.',
      ),
      sampleCount > 0 && onViewSample
        ? createElement(
            'button',
            { type: 'button', className: 'disconnected-sample', 'data-testid': 'view-sample', onClick: onViewSample },
            `View the ${sampleCount}-event sample conversation`,
          )
        : null,
    ),
  );
}
