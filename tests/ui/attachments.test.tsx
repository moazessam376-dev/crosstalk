// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Attachments } from '../../src/ui/cards/Attachments.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Composer } from '../../src/ui/layout/Composer.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { formatLabel } from '../../src/ui/marks/FileMark.js';

/**
 * Attaching a file, and seeing it afterwards.
 *
 * The operator's shape for this, in their words: "there should be visible UI
 * of the picture I have attached, if videos it could be path, just like what
 * happens in claude code, and for files it always have it's unique icons, for
 * example MD or HTML things like this."
 *
 * The behaviour that is easy to get wrong and expensive when it is: uploading
 * happens on *attach*, so a refused file never takes the typed message down
 * with it, and Send is held while an upload is in flight so a message cannot
 * be posted without the picture it was written about.
 */

afterEach(cleanup);

// The repo's tsconfig omits the `dom` lib on purpose, so an `HTMLElement` here
// carries none of these. Narrow casts, named once, matching `message-card.test.tsx`.
function textOf(element: Element): string {
  return (element as unknown as { textContent: string }).textContent;
}

function stateOf(element: Element): string | undefined {
  return (element as unknown as { dataset: Record<string, string | undefined> }).dataset['state'];
}

function within(element: Element, selector: string): Element | null {
  return (element as unknown as { querySelector(s: string): Element | null }).querySelector(selector);
}

function closest(element: Element, selector: string): Element | null {
  return (element as unknown as { closest(s: string): Element | null }).closest(selector);
}

function inDocument(selector: string): Element | null {
  return (globalThis as unknown as { document: { querySelector(s: string): Element | null } })
    .document.querySelector(selector);
}

const SHA = 'a'.repeat(64);

function file(name: string, type: string, bytes = 12): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A fetch that answers `POST /attachments` with a sha, and can be made to fail. */
function uploader(outcome: 'ok' | 'refuse' = 'ok'): typeof fetch {
  return vi.fn(async () =>
    outcome === 'ok'
      ? new Response(
          JSON.stringify({ attachment: { sha: SHA, name: 'x', type: 'image/png', bytes: 12 }, url: `/attachments/${SHA}.png` }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      : new Response(
          JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too large: the cap for this kind of file is 25 MB' } }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        ),
  ) as unknown as typeof fetch;
}

describe('attaching a file to a message', () => {
  it('uploads on attach, not on send', async () => {
    // So the thumbnail appears immediately, and — the half that matters — a
    // failed upload never costs the operator the text they typed.
    const fetchImpl = uploader();
    render(createElement(Composer, { room: '#floor', onSend: vi.fn(), fetchImpl }));

    fireEvent.change(screen.getByTestId('composer-picker'), {
      target: { files: [file('shot.png', 'image/png')] },
    });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [path, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(path).toBe('/attachments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/png');
    // Percent-encoded: header values are Latin-1, and a screenshot is
    // routinely named with an en-dash in it.
    expect((init.headers as Record<string, string>)['x-crosstalk-filename']).toBe('shot.png');
  });

  it('sends the sha with the message, and clears only on success', async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(Composer, { room: '#floor', onSend, fetchImpl: uploader() }));

    fireEvent.change(screen.getByTestId('composer-picker'), {
      target: { files: [file('shot.png', 'image/png')] },
    });
    await waitFor(() => expect(stateOf(screen.getByTestId('composer-attachment'))).toBe('ready'));

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'here is what I mean' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]![1]).toEqual([
      { sha: SHA, name: 'shot.png', type: 'image/png', bytes: 12 },
    ]);
    await waitFor(() => expect(screen.queryByTestId('composer-attachment')).toBeNull());
  });

  it('holds Send while an upload is still going', async () => {
    // Otherwise a fast typist posts "look at this" with nothing attached to
    // look at, and the picture arrives in a later message or not at all.
    let release: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      async () => new Promise<Response>((resolve) => { release = resolve; }),
    ) as unknown as typeof fetch;
    render(createElement(Composer, { room: '#floor', onSend: vi.fn(), fetchImpl }));

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'look at this' } });
    fireEvent.change(screen.getByTestId('composer-picker'), {
      target: { files: [file('shot.png', 'image/png')] },
    });

    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeDisabled());

    release(
      new Response(
        JSON.stringify({ attachment: { sha: SHA, name: 'shot.png', type: 'image/png', bytes: 12 }, url: '/x' }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    await waitFor(() => expect(screen.getByTestId('composer-send')).not.toBeDisabled());
  });

  it('shows a refusal on the file and keeps the typed message', async () => {
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(Composer, { room: '#floor', onSend, fetchImpl: uploader('refuse') }));

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'the whole recording' } });
    fireEvent.change(screen.getByTestId('composer-picker'), {
      target: { files: [file('huge.mov', 'video/quicktime')] },
    });

    await waitFor(() => expect(stateOf(screen.getByTestId('composer-attachment'))).toBe('failed'));
    // The daemon's own words, including the number — an operator who has just
    // dropped a 40 MB file needs to know the cap, not that there is one.
    expect(textOf(screen.getByTestId('composer-attachment'))).toContain('25 MB');
    // And the message survives, which is the whole reason uploading happens
    // on attach rather than on send.
    expect(screen.getByTestId('composer-input')).toHaveValue('the whole recording');

    // Send still works, and posts no attachment rather than a broken one.
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]![1]).toBeUndefined();
  });

  it('takes a pasted file, which is how a screenshot arrives', async () => {
    const fetchImpl = uploader();
    render(createElement(Composer, { room: '#floor', onSend: vi.fn(), fetchImpl }));

    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: { files: [file('Screenshot.png', 'image/png')] },
    });

    await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
  });

  it('takes a dropped file', async () => {
    render(createElement(Composer, { room: '#floor', onSend: vi.fn(), fetchImpl: uploader() }));

    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: { files: [file('notes.md', 'text/markdown')] },
    });

    await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
  });

  it('lets a picture be the whole message', async () => {
    // "Something I am unable to articulate properly" is the case attachments
    // exist for, so requiring words alongside them would refuse exactly the
    // message the operator wanted to send.
    const onSend = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(Composer, { room: '#floor', onSend, fetchImpl: uploader() }));

    fireEvent.change(screen.getByTestId('composer-picker'), {
      target: { files: [file('shot.png', 'image/png')] },
    });
    await waitFor(() => expect(screen.getByTestId('composer-send')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]![1]).toHaveLength(1);
    // And the body is the filename, not a placeholder: a message needs one,
    // and "(attached)" says only that something is — which the picture below
    // it already says.
    expect(onSend.mock.calls[0]![0]).toBe('shot.png');
  });

  it('still refuses an empty message with nothing attached', () => {
    render(createElement(Composer, { room: '#floor', onSend: vi.fn(), fetchImpl: uploader() }));
    expect(screen.getByTestId('composer-send')).toBeDisabled();
  });
});

describe('attachments on a card', () => {
  const shown = (attachments: { sha: string; name: string; type: string; bytes: number }[]) =>
    render(createElement(Attachments, { attachments }));

  it('renders an image inline, linked to its full size', () => {
    shown([{ sha: SHA, name: 'shot.png', type: 'image/png', bytes: 412_000 }]);

    const image = screen.getByAltText('shot.png');
    expect(image).toHaveAttribute('src', `/attachments/${SHA}.png`);
    expect(closest(image, 'a')).toHaveAttribute('href', `/attachments/${SHA}.png`);
  });

  it('renders a video as a chip carrying its path on disk, not a player', () => {
    // The operator asked for the path, "just like what happens in claude
    // code" — and a `/attachments/<sha>` URL is not that: it is a thing to
    // click, not a thing to open in Finder or paste into a command. So the
    // chip shows where the file actually is, which the daemon tells the hub
    // through `/config.json`.
    //
    // A player is deliberately not rendered: one in a scrolling log starts
    // making noise while you are reading something else.
    render(
      createElement(Attachments, {
        attachments: [{ sha: SHA, name: 'demo.mov', type: 'video/quicktime', bytes: 8_000_000 }],
        blobRoot: '/repo/.crosstalk/blobs',
      }),
    );

    const chip = screen.getByTestId('attachment-chip');
    expect(textOf(chip)).toContain('demo.mov');
    // The path is on the button rather than in the text: rendered inline in a
    // 320-pixel chip it ellipsises to the *shape* of a path, which is worse
    // than not showing one. Here it is one click from the clipboard.
    expect(screen.getByTestId('attachment-copy')).toHaveAttribute(
      'title',
      `/repo/.crosstalk/blobs/${SHA.slice(0, 2)}/${SHA}.mov`,
    );
    expect(inDocument('video')).toBeNull();
  });

  it('copies the path when asked', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    render(
      createElement(Attachments, {
        attachments: [{ sha: SHA, name: 'demo.mov', type: 'video/quicktime', bytes: 8_000_000 }],
        blobRoot: '/repo/.crosstalk/blobs',
      }),
    );

    fireEvent.click(screen.getByTestId('attachment-copy'));

    expect(written).toEqual([`/repo/.crosstalk/blobs/${SHA.slice(0, 2)}/${SHA}.mov`]);
    await waitFor(() => expect(textOf(screen.getByTestId('attachment-copy'))).toBe('copied'));
  });

  it('falls back to the size when nothing told it where blobs live', () => {
    // Against a fixture there is no daemon and no `blobRoot`, and a chip that
    // showed a path built from `undefined` would be worse than one that showed
    // the size.
    shown([{ sha: SHA, name: 'demo.mov', type: 'video/quicktime', bytes: 8_000_000 }]);

    const chip = screen.getByTestId('attachment-chip');
    expect(textOf(chip)).toContain('7.6 MB');
    expect(textOf(chip)).not.toContain('undefined');
    // And no copy button, because there is no path to copy.
    expect(screen.queryByTestId('attachment-copy')).toBeNull();
  });

  it('gives a file its own format badge', () => {
    shown([{ sha: SHA, name: 'PLAN.md', type: 'text/markdown', bytes: 4_100 }]);

    const chip = screen.getByTestId('attachment-chip');
    expect(textOf(chip)).toContain('MD');
    expect(textOf(chip)).toContain('PLAN.md');
    expect(textOf(chip)).toContain('4 KB');
  });

  it('sends a file as a download rather than opening it as a page', () => {
    // An SVG or an HTML file served inline from the hub's own origin is
    // same-origin script. The daemon sets the disposition; the hub asks for it
    // explicitly too, so neither side is the only thing standing there.
    shown([{ sha: SHA, name: 'diagram.svg', type: 'image/svg+xml', bytes: 900 }]);

    expect(within(screen.getByTestId('attachment-chip'), 'a')).toHaveAttribute(
      'href',
      `/attachments/${SHA}.svg?download=1`,
    );
    expect(inDocument('img')).toBeNull();
  });

  it('degrades a missing blob to a chip, never a broken image', () => {
    // A card from an archived run whose blobs were collected is exactly where
    // this shows up, and a broken-image glyph reads as a bug in the hub rather
    // than a file that is gone.
    shown([{ sha: SHA, name: 'gone.png', type: 'image/png', bytes: 1 }]);
    fireEvent.error(screen.getByAltText('gone.png'));

    const chip = screen.getByTestId('attachment-chip');
    expect(textOf(chip)).toContain('missing');
    expect(within(chip, 'a')).not.toHaveAttribute('href');
  });
});

describe('the format badge', () => {
  it('names the formats the operator asked about', () => {
    expect(formatLabel('text/markdown', 'a.md')).toBe('MD');
    expect(formatLabel('text/html', 'a.html')).toBe('HTML');
  });

  it('falls back to the author’s own extension, not to a generic word', () => {
    // An unlisted format is unfamiliar, not broken, and the badge should say
    // which. A switch that drew "FILE" for everything unknown would make the
    // operator's `.tsx` look like a bug.
    expect(formatLabel('application/octet-stream', 'Component.tsx')).toBe('TSX');
    expect(formatLabel('application/octet-stream', 'noextension')).toBe('FILE');
  });
});
