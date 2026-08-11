// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import App from '../../src/ui/App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('rendered hub wiring', () => {
  it('hands the cross-room dispute claim from the fixture to the rendered view', async () => {
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-dispute.jsonl'), 'utf8');
    // A fresh Response per call, not one shared instance: a body can only be
    // consumed once, and App now fetches `/config.json` before the fixture.
    // `mockResolvedValue` handed the same Response to both, so the second
    // read came back empty and the hub rendered nothing.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(fixture, { status: 200 }))));

    render(createElement(App));

    // CT-10: with no daemon the hub is not drawn at all — the sample is opened
    // on request, so that "0 events" can only ever mean live-and-quiet.
    fireEvent.click(await screen.findByTestId('view-sample'));

    const claimCard = await screen.findByTestId('dispute-claim-C-118');
    expect(claimCard).toHaveAttribute('data-claim-state', 'contested');
    // No denominator: this is fixture mode, so no daemon supplied
    // `policy.dispute.maxRounds`. It used to read "round 3 / 3" from a
    // hard-coded constant that happened to match nothing in particular (C2).
    expect(screen.getByText('round 3')).toBeInTheDocument();
    expect(screen.queryByText('No claim has been raised in this room.')).not.toBeInTheDocument();
  });
});
