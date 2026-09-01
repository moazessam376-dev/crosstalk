import { createElement, useState } from 'react';

import type { MessageAttachment } from '../../contracts/events.js';
import { attachmentPath, attachmentUrl, humanBytes } from '../../core/attachments.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { FileMark } from '../marks/FileMark.js';

/**
 * Attachments as they appear on a message that has already been sent.
 *
 * Three renderings, decided by the operator: "there should be visible UI of
 * the picture I have attached, if videos it could be path, just like what
 * happens in claude code, and for files it always have it's unique icons, for
 * example MD or HTML things like this."
 *
 * - **image** — inline, height-clamped, click to open full size
 * - **video** — a chip with the path, copyable, because a video autoplaying in
 *   a scrolling log is worse than a line of text saying where it is
 * - **everything else** — a chip with the format drawn on a page
 *
 * A blob the daemon no longer has degrades to a "missing" chip rather than a
 * broken image. That is not a nicety: attachments outlive their run only if
 * they are still referenced, so a card from an archived run is exactly where a
 * missing one shows up, and a broken-image glyph would read as a bug in the
 * hub rather than as a file that was collected.
 */

export interface AttachmentsProps {
  attachments: readonly MessageAttachment[];
  /**
   * Where blobs are on this machine, from `/config.json`.
   *
   * Only a video uses it, and only to show what the operator asked for: "if
   * videos it could be path, just like what happens in claude code". Absent
   * against a fixture, where the chip falls back to its size.
   */
  blobRoot?: string;
}

function Image({ attachment, href }: { attachment: MessageAttachment; href: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return createElement(Chip, { attachment, href, missing: true });

  return createElement(
    'a',
    {
      className: 'attachment-image',
      href,
      target: '_blank',
      rel: 'noreferrer',
      title: `${attachment.name} · ${humanBytes(attachment.bytes)}`,
    },
    createElement('img', {
      src: href,
      alt: attachment.name,
      loading: 'lazy',
      onError: () => setBroken(true),
    }),
  );
}

function Chip({
  attachment,
  href,
  missing = false,
  path,
}: {
  attachment: MessageAttachment;
  href: string;
  missing?: boolean;
  path?: string;
}) {
  const [copied, setCopied] = useState(false);

  return createElement(
    'span',
    { className: `attachment-chip${missing ? ' is-missing' : ''}`, 'data-testid': 'attachment-chip' },
    createElement(
      'a',
      {
        className: 'attachment-open',
        href: missing ? undefined : `${href}?download=1`,
        // Not `target: _blank` — this one downloads, and a tab that opens and
        // immediately closes is a worse way to say so than the download.
        title: path ?? attachment.name,
      },
      createElement(FileMark, { type: attachment.type, name: attachment.name, size: 26 }),
      createElement(
        'span',
        { className: 'attachment-facts' },
        createElement('span', { className: 'attachment-name' }, attachment.name),
        createElement(
          'span',
          { className: 'attachment-sub fact' },
          missing ? 'missing' : humanBytes(attachment.bytes),
        ),
      ),
    ),
    /**
     * The path, on demand rather than on screen.
     *
     * The operator asked for a video's path, "just like what happens in claude
     * code" — but Claude Code has a full-width terminal and this chip is 320
     * pixels. Rendered inline, a ninety-character path ellipsises to
     * `/Users/…/.crosstalk/blobs/35/35bce4…`, which is not a path; it is the
     * shape of one. So the chip stays readable and the path is one click away,
     * in the form the operator would actually use it: pasted into a command.
     */
    path === undefined || missing
      ? null
      : createElement(
          'button',
          {
            type: 'button',
            className: 'attachment-copy',
            'data-testid': 'attachment-copy',
            title: path,
            'aria-label': `Copy the path to ${attachment.name}`,
            onClick: () => {
              // Reached through `globalThis` rather than the `navigator`
              // global: no `dom` lib here, and the clipboard is absent
              // outside a secure context anyway, so it is optional either way.
              void (
                globalThis as unknown as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
              ).navigator?.clipboard?.writeText(path);
              setCopied(true);
              // Reverts on its own: a button that says "copied" forever stops
              // saying anything.
              setTimeout(() => setCopied(false), 1600);
            },
          },
          copied ? 'copied' : 'copy path',
        ),
  );
}

export function Attachments({ attachments, blobRoot }: AttachmentsProps) {
  if (attachments.length === 0) return null;

  return createElement(
    'div',
    { className: 'attachments', 'data-testid': 'attachments' },
    ...attachments.map((attachment) => {
      const href = attachmentUrl(attachment.sha, attachment.type);
      if (attachment.type.startsWith('image/') && attachment.type !== 'image/svg+xml') {
        return createElement(Image, { key: attachment.sha + attachment.name, attachment, href });
      }
      if (attachment.type.startsWith('video/')) {
        // The path, as the operator asked — the same thing Claude Code shows
        // for a video. A player in a scrolling log is a thing that starts
        // making noise while you are reading something else.
        return createElement(Chip, {
          key: attachment.sha + attachment.name,
          attachment,
          href,
          ...(blobRoot === undefined
            ? {}
            : { path: attachmentPath(blobRoot, attachment.sha, attachment.type) }),
        });
      }
      return createElement(Chip, { key: attachment.sha + attachment.name, attachment, href });
    }),
  );
}
