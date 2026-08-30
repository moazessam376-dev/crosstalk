// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ComposeForm } from '../../src/ui/layout/ComposeForm.js';

afterEach(cleanup);

function textOf(element: Element): string {
  return (element as unknown as { textContent: string }).textContent;
}

describe('compose form', () => {
  it('lists PATH probes and posts the job on Start', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url === '/harnesses') {
        return Promise.resolve(
          new Response(JSON.stringify({
            harnesses: [
              { binary: 'claude', available: true },
              { binary: 'codex', available: false },
              { binary: 'cursor-agent', available: true },
            ],
          }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    const started: string[] = [];

    render(
      createElement(ComposeForm, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onStart: async (job) => {
          started.push(job);
          return { ok: true };
        },
      }),
    );

    await waitFor(() => {
      expect(textOf(screen.getByTestId('compose-harnesses'))).toContain('claude');
    });
    expect(textOf(screen.getByTestId('compose-harnesses'))).toContain('attach only');

    fireEvent.change(screen.getByTestId('compose-job'), { target: { value: 'Ship the list' } });
    fireEvent.click(screen.getByTestId('compose-start'));

    await waitFor(() => {
      expect(started).toEqual(['Ship the list']);
    });
    expect(textOf(screen.getByTestId('compose-notice'))).toContain('#floor');
  });
});
