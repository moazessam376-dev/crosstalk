import { useCallback, useState } from 'react';

import type { MessageAttachment } from '../../contracts/events.js';

/**
 * Files the operator has attached but not yet sent.
 *
 * **Uploaded on attach, not on send.** Two reasons, and the second is the one
 * that matters: the thumbnail can appear the moment the screenshot is pasted,
 * and a failed upload never costs the operator the text they typed. Sending
 * would otherwise be a single action that can fail two ways, and the way it
 * fails second is the one that eats the message.
 *
 * Each item carries its own state, so a 40 MB refusal sits beside a
 * screenshot that went up fine, and `Send` posts only the ones that are ready.
 */

/**
 * A file, as much of one as this project's types admit.
 *
 * The repo's tsconfig omits the `dom` lib on purpose, so `File`, `FileList`
 * and `Blob` are not names here. Everything this module needs from a file is
 * its name, its type, its size and the ability to be a request body — so that
 * is what it asks for, and a real `File` satisfies it structurally.
 */
export interface AttachedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export type DraftState = 'uploading' | 'ready' | 'failed';

export interface DraftAttachment {
  /** Stable across the item's life, so React keys survive the upload. */
  key: string;
  name: string;
  type: string;
  bytes: number;
  state: DraftState;
  /** A local `blob:` URL, so an image previews before the daemon answers. */
  preview?: string;
  /** Set once the daemon has the bytes. */
  sha?: string;
  /** Where the hub fetches it from. */
  url?: string;
  /** Why it failed, in the daemon's own words. */
  reason?: string;
}

/** The record that goes on the message. Ready items only. */
export function sendable(drafts: readonly DraftAttachment[]): MessageAttachment[] {
  return drafts
    .filter((draft): draft is DraftAttachment & { sha: string } => draft.state === 'ready' && draft.sha !== undefined)
    .map((draft) => ({ sha: draft.sha, name: draft.name, type: draft.type, bytes: draft.bytes }));
}

/**
 * A media type for a file the browser could not name.
 *
 * Chrome gives `''` for a `.md` and for anything else it has no table entry
 * for, and an empty `content-type` is refused by the daemon — so the operator
 * would attach a Markdown file and be told the file has no type, which is
 * true and useless. Guessed from the extension here, once, rather than in
 * three call sites.
 */
export function typeOf(file: { name: string; type: string }): string {
  if (file.type !== '') return file.type;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const guesses: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };
  return guesses[ext] ?? 'application/octet-stream';
}

let counter = 0;

export function useAttachments(fetchImpl: typeof fetch = fetch): {
  drafts: DraftAttachment[];
  attach: (files: readonly AttachedFile[]) => void;
  remove: (key: string) => void;
  clear: () => void;
} {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);

  const patch = useCallback((key: string, change: Partial<DraftAttachment>): void => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  }, []);

  const attach = useCallback(
    (files: readonly AttachedFile[]): void => {
      for (const file of files) {
        counter += 1;
        const key = `a${counter}`;
        const type = typeOf(file);
        setDrafts((current) => [
          ...current,
          {
            key,
            name: file.name === '' ? 'pasted image' : file.name,
            type,
            bytes: file.size,
            state: 'uploading',
            // Local, so the operator sees the picture immediately rather than
            // a spinner. Revoked when the item goes.
            ...(type.startsWith('image/') && typeof URL.createObjectURL === 'function'
              ? { preview: URL.createObjectURL(file as unknown as Parameters<typeof URL.createObjectURL>[0]) }
              : {}),
          },
        ]);

        void (async () => {
          try {
            const response = await fetchImpl('/attachments', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'content-type': type,
                // Percent-encoded: header values are Latin-1, and a screenshot
                // is routinely called something with an en-dash in it.
                'x-crosstalk-filename': encodeURIComponent(file.name),
              },
              // A real `File` is a valid body; the structural type above is
              // not one TypeScript can prove that about without the dom lib.
              body: file as unknown as Parameters<typeof fetchImpl>[1] extends { body?: infer B } ? B : never,
            });
            if (!response.ok) {
              const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
              patch(key, { state: 'failed', reason: detail.error?.message ?? `refused (${response.status})` });
              return;
            }
            const body = (await response.json()) as {
              attachment: { sha: string; bytes: number };
              url: string;
            };
            patch(key, {
              state: 'ready',
              sha: body.attachment.sha,
              bytes: body.attachment.bytes,
              url: body.url,
            });
          } catch (error) {
            patch(key, { state: 'failed', reason: (error as Error).message });
          }
        })();
      }
    },
    [fetchImpl, patch],
  );

  const remove = useCallback((key: string): void => {
    setDrafts((current) => {
      const going = current.find((draft) => draft.key === key);
      if (going?.preview !== undefined && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(going.preview);
      }
      return current.filter((draft) => draft.key !== key);
    });
  }, []);

  const clear = useCallback((): void => {
    setDrafts((current) => {
      for (const draft of current) {
        if (draft.preview !== undefined && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(draft.preview);
        }
      }
      return [];
    });
  }, []);

  return { drafts, attach, remove, clear };
}
