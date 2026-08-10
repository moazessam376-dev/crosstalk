// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import App from '../../src/ui/App.js';
import { loadHubConfig } from '../../src/ui/state/hubConfig.js';
import { postHumanAction } from '../../src/ui/state/humanAction.js';
import type { HubConnection } from '../../src/ui/state/hubConfig.js';

/**
 * The hub read a fixture file and nothing connected it to a daemon. These
 * cover the seam that was invisible from inside the test runner: a component
 * test proves a component draws correctly *given* data, never that anything
 * hands it data.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The repo's tsconfig omits `jsx` and the `dom` lib on purpose, so a .tsx
// default export resolves without its props type. Naming it once here keeps
// the casts out of every render call.
const Hub = App as unknown as (props: { connection?: HubConnection }) => ReactElement;

const live: HubConnection = {
  kind: 'live',
  config: { version: 1, self: '@human', streamUrl: '/stream', room: '#floor' },
};

describe('loadHubConfig', () => {
  it('reports live when the daemon answers with a usable descriptor', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ version: 1, self: '@human', streamUrl: '/stream', room: '#floor' }), { status: 200 })),
    );

    await expect(loadHubConfig(fetchImpl as unknown as typeof fetch)).resolves.toEqual(live);
  });

  // Each of these is a different reason to fall back, and each must SAY so.
  // A hub that silently shows a sample conversation is indistinguishable from
  // one showing a real, quiet one.
  it.each([
    ['a 404 from a static build', () => Promise.resolve(new Response('nope', { status: 404 })), /404/],
    ['a 401 refusal', () => Promise.resolve(new Response('', { status: 401 })), /cookie/i],
    ['a body that is not JSON', () => Promise.resolve(new Response('not json', { status: 200 })), /not JSON/i],
    ['a JSON body missing its fields', () => Promise.resolve(new Response('{"version":1}', { status: 200 })), /self, streamUrl and room/],
    ['no daemon at all', () => Promise.reject(new Error('ECONNREFUSED')), /No daemon answered/],
  ])('falls back to the fixture on %s, and explains why', async (_label, impl, expected) => {
    const result = await loadHubConfig(impl as unknown as typeof fetch);

    expect(result.kind).toBe('fixture');
    expect(result.kind === 'fixture' && result.reason).toMatch(expected);
  });
});

describe('the human is a participant, not a spectator', () => {
  it('posts a message the whole room can see, and never asserts its own identity', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{"events":[]}', { status: 201 })));

    const result = await postHumanAction({ type: 'intervene_human' }, '#floor', fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/events');
    expect(init.credentials).toBe('same-origin');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.kind).toBe('message');
    expect(body.room).toBe('#floor');
    expect(String(body.body)).toMatch(/intervening/i);
    // The daemon derives `from` from the cookie and rejects a payload that
    // sets it. A hub that sent one would be refused, and would deserve to be.
    expect(body).not.toHaveProperty('from');
  });

  it('surfaces a refusal instead of pretending the click worked', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 401 })));

    const result = await postHumanAction({ type: 'propose_test' }, '#floor', fetchImpl as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/refused this browser/i);
  });
});

describe('App against a live daemon', () => {
  it('selects the SSE stream and says it is live', async () => {
    const listeners: Record<string, ((event: MessageEvent) => void) | null> = {};
    class FakeEventSource {
      constructor(readonly url: string) {
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      onopen: ((event: Event) => void) | null = null;
      set onmessage(fn: (event: MessageEvent) => void) { listeners['message'] = fn; }
      onerror: ((event: Event) => void) | null = null;
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    render(createElement(Hub, { connection: live }));

    // Empty and live is a first run, and must be said out loud. "connected"
    // over a blank screen is exactly the failure this project shipped once.
    await waitFor(() => expect(screen.getByTestId('empty-log')).toBeInTheDocument());
    expect(screen.getByTestId('empty-log')).toHaveTextContent('@human');
    expect(screen.getByText('live — waiting for the first event')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('data-source', 'live');
  });

  it('tells the human why a button did nothing when there is no daemon', async () => {
    // The buttons live in DisputeView, which only exists once a dispute room
    // does — so the fixture has to actually load for this to test anything.
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-dispute.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(fixture, { status: 200 }))));

    render(createElement(Hub, { connection: { kind: 'fixture', reason: 'no daemon' } as HubConnection }));

    const button = await screen.findByTestId('human-action-intervene');
    fireEvent.click(button);

    expect(await screen.findByTestId('human-action-notice')).toHaveTextContent(/nobody to tell/i);
  });

  it('names the reason it is showing a fixture', () => {
    render(createElement(Hub, { connection: { kind: 'fixture', reason: 'daemon said 404' } as HubConnection }));

    expect(screen.getByTestId('fixture-reason')).toHaveTextContent('daemon said 404');
    expect(screen.getByText(/offline — showing a sample conversation/)).toBeInTheDocument();
  });
});

/**
 * C2's real risk is not the arithmetic, it is the wiring. `deriveState` is a
 * pure function of events with no access to `HubConfig`, and `DisputeViewProps`
 * had no config field — so every layer could be tested with the value passed in
 * while `App` never passed it. That is audit F-09's shape exactly, and this
 * project has already shipped it once.
 */
describe('C2 maxRounds reaches the screen from the daemon config', () => {
  it('renders the configured denominator in both the header and the channel row', async () => {
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-dispute.jsonl'), 'utf8');
    const logged = fixture.split(/\r?\n/).filter((line) => line.trim().length > 0);

    let deliver: ((event: MessageEvent) => void) | undefined;
    class FakeEventSource {
      constructor(readonly url: string) {
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      onopen: ((event: Event) => void) | null = null;
      set onmessage(fn: (event: MessageEvent) => void) { deliver = fn; }
      onerror: ((event: Event) => void) | null = null;
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const liveDispute: HubConnection = {
      kind: 'live',
      config: { version: 1, self: '@human', streamUrl: '/stream', room: 'dispute:C-118', maxRounds: 5 },
    };

    render(createElement(Hub, { connection: liveDispute }));
    await waitFor(() => expect(deliver).toBeDefined());
    for (const line of logged) deliver!(new MessageEvent('message', { data: line }));

    // The header and the channel row are fed by two different paths — a prop
    // and `deriveState` — which is exactly why they disagreed before.
    await waitFor(() => expect(screen.getByText(/round \d+ \/ 5/)).toBeInTheDocument());
    expect(screen.getByText(/^\d+\/5$/)).toBeInTheDocument();
  });

  it('shows no denominator anywhere when the daemon did not send one', async () => {
    // Fixture mode. A `3` appearing here is the deleted constant coming back.
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-dispute.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(fixture, { status: 200 }))));

    render(createElement(Hub, { connection: { kind: 'fixture', reason: 'no daemon' } as HubConnection }));

    await waitFor(() => expect(screen.getByTestId('dispute-view')).toBeInTheDocument());
    expect(screen.getByTestId('dispute-view')).not.toHaveTextContent(/round \d+ \/ 3/);
    expect(screen.getByText(/^round \d+$/)).toBeInTheDocument();
  });
});
