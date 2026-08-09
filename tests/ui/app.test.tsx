// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture, { status: 200 })));

    render(createElement(App));

    const claimCard = await screen.findByTestId('dispute-claim-C-118');
    expect(claimCard).toHaveAttribute('data-claim-state', 'contested');
    expect(screen.getByText('round 3 / 3')).toBeInTheDocument();
    expect(screen.queryByText('No claim has been raised in this room.')).not.toBeInTheDocument();
  });
});
