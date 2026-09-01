import { createElement, useRef, useState, type KeyboardEvent } from 'react';
import type { MessageAttachment } from '../../contracts/events.js';
import { humanBytes } from '../../core/attachments.js';
import type { PostResult } from '../state/humanAction.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { FileMark } from '../marks/FileMark.js';
import { sendable, useAttachments, type AttachedFile, type DraftAttachment } from '../state/useAttachments.js';

export interface ComposerProps {
  /** The room this message is posted into. Named on screen, not implied. */
  room: string;
  /** Who the daemon will attribute this to. Derived from the cookie, never asserted here. */
  self?: string;
  onSend: (body: string, attachments?: readonly MessageAttachment[]) => Promise<PostResult>;
  /** What to call the poster. The log still records `self`. */
  operator?: string;
  /** Seam for tests; the real one is the browser's. */
  fetchImpl?: typeof fetch;
}

/**
 * The human's way into the conversation.
 *
 * Design §10.3 gives the human a composer on every room, and there was no
 * `<input>` or `<textarea>` anywhere in `src/ui/` — the person the ladder ends
 * on could read the argument and not answer it.
 *
 * The field clears only on a confirmed post. Losing what someone typed because
 * a request failed is not an acceptable failure mode, and it is the one thing
 * a composer must never do. Attachments follow the same rule from the other
 * end: they upload the moment they are attached, so a refused file never
 * takes the message down with it.
 *
 * Three ways in, paste first because these are mostly macOS screenshots:
 * ⌘V into the field, drag onto it, or the paperclip.
 */
export function Composer({
  room,
  self = '@human',
  onSend,
  operator,
  fetchImpl = fetch,
}: ComposerProps) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Structural, like `Stream`'s scroller ref: no `dom` lib, no HTMLInputElement.
  const picker = useRef<{ click(): void } | null>(null);
  const { drafts, attach, remove, clear } = useAttachments(fetchImpl);

  const ready = sendable(drafts);
  const busy = drafts.some((draft) => draft.state === 'uploading');

  async function send(): Promise<void> {
    const text = body.trim();
    // A message may be a picture and nothing else — "something I am unable to
    // articulate properly" is the case attachments exist for. But whitespace
    // with nothing attached is not a message, and posting it would put an
    // empty card in everyone's stream.
    if (text.length === 0 && ready.length === 0) return;

    setSending(true);
    // A message needs a body — every reader that predates the amendment treats
    // `body` as the message, and an empty one is a blank card. When there are
    // no words, the filenames are the most useful thing to put there: "(attached)"
    // says only that something is, which the picture below already says.
    const result = await onSend(
      text === '' ? ready.map((file) => file.name).join(', ') : text,
      ready.length > 0 ? ready : undefined,
    );
    setSending(false);

    if (result.ok) {
      setBody('');
      clear();
      setError(undefined);
      return;
    }
    setError(result.reason);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Shift+Enter is how you write a second line. Sending it would eat a
    // half-written message.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  /**
   * Files off a paste or a drop.
   *
   * A paste carrying files *also* carries a text flavour in some apps, so the
   * default is only prevented when there is actually a file — otherwise
   * pasting text into the composer would silently do nothing, which is a much
   * worse bug than the one this is here to add.
   */
  function take(list: ArrayLike<AttachedFile> | null | undefined, event?: { preventDefault: () => void }): void {
    // `Array.from` and not spread: a `FileList` is array-like without being
    // iterable in the type system here, and the `dom` lib that would say
    // otherwise is deliberately absent.
    const files = list === null || list === undefined ? [] : Array.from(list);
    if (files.length === 0) return;
    event?.preventDefault();
    attach(files);
  }

  const strip =
    drafts.length === 0
      ? null
      : createElement(
          'ul',
          { className: 'composer-attachments', 'data-testid': 'composer-attachments' },
          ...drafts.map((draft) => createElement(DraftChip, { key: draft.key, draft, onRemove: remove })),
        );

  return createElement(
    'form',
    {
      className: `composer${dragging ? ' is-dropping' : ''}`,
      'data-testid': 'composer',
      onSubmit: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        void send();
      },
      onDragOver: (event: { preventDefault: () => void }) => {
        // Without this the browser navigates away to the dropped file, which
        // loses the half-typed message and looks like a crash.
        event.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: (event: { preventDefault: () => void; dataTransfer?: { files?: ArrayLike<AttachedFile> } }) => {
        setDragging(false);
        take(event.dataTransfer?.files, event);
      },
    },
    createElement(
      'div',
      { className: 'composer-meta' },
      createElement('span', null, 'posting as'),
      createElement('span', { className: 'composer-identity', 'data-testid': 'composer-identity' }, operator ?? self),
      createElement('span', null, 'into'),
      createElement('span', { className: 'composer-room fact' }, room),
      // Said out loud because it is true and easy to forget: this is not a
      // private note to the leader.
      createElement('span', { className: 'composer-scope' }, 'everyone in this room sees it'),
    ),
    strip,
    createElement('textarea', {
      className: 'composer-input',
      'data-testid': 'composer-input',
      'aria-label': `post to ${room} as ${self}`,
      placeholder: `Message ${room} — @mention an agent to route it`,
      rows: 2,
      value: body,
      disabled: sending,
      onKeyDown,
      onPaste: (event: { preventDefault: () => void; clipboardData?: { files?: ArrayLike<AttachedFile> } }) =>
        take(event.clipboardData?.files, event),
      onChange: (event: { target: { value: string } }) => setBody(event.target.value),
    }),
    createElement('input', {
      ref: picker,
      type: 'file',
      multiple: true,
      className: 'composer-picker',
      'data-testid': 'composer-picker',
      'aria-label': 'attach files',
      onChange: (event: { target: { files: ArrayLike<AttachedFile> | null; value: string } }) => {
        take(event.target.files);
        // Cleared so attaching the same file twice in a row fires `change`
        // the second time. Without it the picker silently does nothing.
        event.target.value = '';
      },
    }),
    createElement(
      'div',
      { className: 'composer-actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'composer-attach',
          'data-testid': 'composer-attach',
          'aria-label': 'Attach a file',
          title: 'Attach a file — or paste, or drop one here',
          onClick: () => picker.current?.click(),
        },
        createElement(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            'aria-hidden': 'true',
          },
          createElement('path', { d: 'M10.6 4.3 5.5 9.4a1.9 1.9 0 0 0 2.7 2.7l5.1-5.1a3.3 3.3 0 0 0-4.7-4.7L3.2 7.7a4.7 4.7 0 0 0 6.6 6.6l4.4-4.4' }),
        ),
      ),
      createElement('span', { className: 'composer-route fact' }, 'POST /events'),
      createElement(
        'button',
        {
          type: 'submit',
          className: 'composer-send',
          'data-testid': 'composer-send',
          'aria-label': sending ? 'Sending' : 'Send',
          title: busy ? 'Waiting for an attachment to finish' : sending ? 'Sending' : 'Send',
          // Held while an upload is in flight, so Send cannot quietly post the
          // message without the picture it was written about.
          disabled: sending || busy || (body.trim().length === 0 && ready.length === 0),
        },
        createElement(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': 'true' },
          createElement('path', { d: 'M8 13V3.5' }),
          createElement('path', { d: 'M3.8 7.5 8 3.3l4.2 4.2' }),
        ),
      ),
    ),
    error === undefined
      ? null
      : createElement('p', { className: 'composer-error', role: 'alert', 'data-testid': 'composer-error' }, error),
  );
}

/** One attached file, before it is sent: a thumbnail or a badge, and a way out. */
function DraftChip({ draft, onRemove }: { draft: DraftAttachment; onRemove: (key: string) => void }) {
  return createElement(
    'li',
    {
      className: `composer-attachment is-${draft.state}`,
      'data-testid': 'composer-attachment',
      'data-state': draft.state,
    },
    draft.preview === undefined
      ? createElement(FileMark, { type: draft.type, name: draft.name, size: 24 })
      : createElement('img', { className: 'composer-thumb', src: draft.preview, alt: draft.name }),
    createElement(
      'span',
      { className: 'composer-attachment-facts' },
      createElement('span', { className: 'composer-attachment-name' }, draft.name),
      createElement(
        'span',
        { className: 'composer-attachment-sub fact' },
        draft.state === 'uploading'
          ? 'uploading…'
          : draft.state === 'failed'
            ? (draft.reason ?? 'failed')
            : humanBytes(draft.bytes),
      ),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'composer-attachment-remove',
        'aria-label': `Remove ${draft.name}`,
        onClick: () => onRemove(draft.key),
      },
      '×',
    ),
  );
}
