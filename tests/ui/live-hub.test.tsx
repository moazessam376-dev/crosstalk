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

// The repo's tsconfig omits the `dom` lib on purpose, so `HTMLTextAreaElement`
// carries no `value`. Reading it through one narrow cast keeps that out of
// every assertion.
function valueOf(field: Element): string {
  return (field as unknown as { value: string }).value;
}

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

    expect(result).toEqual({ ok: true as const });
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

/**
 * C3. The composer is only worth building if something hands it a working
 * `onSend`. `onHumanAction` was threaded through three layers to two buttons
 * and `App` never passed a handler — audit F-09 — so both buttons were inert
 * while every layer's own test passed.
 */
describe('C3 the human can actually speak', () => {
  function stubStream(): void {
    class FakeEventSource {
      constructor(readonly url: string) {
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      onopen: ((event: Event) => void) | null = null;
      set onmessage(_fn: (event: MessageEvent) => void) {}
      onerror: ((event: Event) => void) | null = null;
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
  }

  it('posts what was typed to the active room, as one request', async () => {
    stubStream();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response('', { status: 201 }));
      }),
    );

    render(createElement(Hub, { connection: live }));

    const field = await screen.findByTestId('composer-input');
    fireEvent.change(field, { target: { value: 'Stop and wait for my ruling.' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/events');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      kind: 'message',
      room: '#floor',
      body: 'Stop and wait for my ruling.',
    });
  });

  it('keeps the text when the daemon refuses it', async () => {
    stubStream();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 401 }))));

    render(createElement(Hub, { connection: live }));

    const field = await screen.findByTestId('composer-input');
    fireEvent.change(field, { target: { value: 'a message worth keeping' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent(/refused this browser/i);
    expect(valueOf(field)).toBe('a message worth keeping');
  });
});

/**
 * C3. The vote is the one §10.3 affordance that needs no new route, and the
 * one without which an escalated dispute cannot terminate. Same wiring risk as
 * the composer, so it gets the same App-level test.
 */
describe('C3 the human can rule from the hub', () => {
  it('posts the vote and its rationale to the decision route', async () => {
    // session-dispute.jsonl's decision is already resolved, so it cannot
    // exercise an open vote. session-ladder.jsonl carries an unresolved ladder
    // decision that names @human as a voter.
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-ladder.jsonl'), 'utf8');
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

    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response('', { status: 201 }));
      }),
    );

    // Eligibility is the decision's own `voters` list, not a role.
    const asVoter: HubConnection = {
      kind: 'live',
      config: { version: 1, self: '@human', streamUrl: '/stream', room: 'dispute:C-200' },
    };

    render(createElement(Hub, { connection: asVoter }));
    await waitFor(() => expect(deliver).toBeDefined());
    for (const line of logged) deliver!(new MessageEvent('message', { data: line }));

    const rationale = await screen.findByTestId('vote-rationale-D-09');
    fireEvent.change(rationale, { target: { value: 'The replay run settles it.' } });
    fireEvent.click(screen.getByTestId('vote-option-D-09-once'));

    await waitFor(() => expect(calls.some((call) => call.url.includes('/vote'))).toBe(true));
    const vote = calls.find((call) => call.url.includes('/vote'))!;
    expect(vote.url).toBe('/decisions/D-09/vote');
    expect(JSON.parse(String(vote.init.body))).toEqual({ option: 'once', rationale: 'The replay run settles it.' });
  });
});

/**
 * C1's acceptance, driven through the whole component tree from a real log
 * rather than from hand-built props. This is the nearest thing to the live pass
 * that can run before Track A merges: it still cannot prove a daemon emits
 * these events, which is why the live pass is a separate, required step.
 */
describe('C1 the dispute screen against a real ladder log', () => {
  it('shows both falsifiers and tells skipped, failed and current rungs apart', async () => {
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-ladder.jsonl'), 'utf8');
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

    render(
      createElement(Hub, {
        connection: {
          kind: 'live',
          config: { version: 1, self: 'leader', streamUrl: '/stream', room: 'dispute:C-200', maxRounds: 3 },
        },
      }),
    );
    await waitFor(() => expect(deliver).toBeDefined());
    for (const line of logged) deliver!(new MessageEvent('message', { data: line }));

    // Both falsifiers, on screen at once, after an uphold. Asserted on the
    // text, not on the presence of a node.
    await waitFor(() =>
      expect(screen.getByText('produce() and consume() would reference different multipliers.')).toBeInTheDocument(),
    );
    expect(screen.getByText('Re-running without --after-replay leaves the ledger balanced.')).toBeInTheDocument();

    // The log says currentRung 0 and rung_entered index 2. Rule 1 says 2.
    expect(screen.getByTestId('ladder-rung-leader')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('ladder-rung-discriminating_test')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('ladder-rung-third_agent')).toHaveAttribute('data-state', 'skipped');
    expect(screen.getByTestId('ladder-rung-third_agent')).toHaveAttribute(
      'title',
      'only one worker is configured, so there is no uninvolved peer',
    );

    // Two proposals at two commits, said out loud rather than left implicit.
    expect(screen.getByTestId('test-proposal-9')).toHaveTextContent('9f31aa4');
    expect(screen.getByTestId('test-proposal-9-divergence')).toHaveTextContent('20b08a7');

    // Four responses on a maxRounds-3 dispute reads 4 / 3, not 3 / 3.
    expect(screen.getByText('round 3 / 3')).toBeInTheDocument();
  });
});

describe('C3 the composer without a daemon', () => {
  it('is still there, and says why it cannot post', async () => {
    // The two canned buttons already behave this way: shown, and they explain
    // themselves on click. A composer that vanishes instead is a different
    // answer to the same question, and it also means `vite dev` and a static
    // build show no composer at all.
    const fixture = await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'session-dispute.jsonl'), 'utf8');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(fixture, { status: 200 }))));

    render(createElement(Hub, { connection: { kind: 'fixture', reason: 'no daemon' } as HubConnection }));

    const field = await screen.findByTestId('composer-input');
    fireEvent.change(field, { target: { value: 'is anyone there' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent(/nobody to tell/i);
    expect(valueOf(field)).toBe('is anyone there');
  });
});
