import { createElement, useEffect, useState } from 'react';

export interface HarnessProbe {
  binary: string;
  available: boolean;
}

export interface ComposeFormProps {
  onStart?: (job: string) => Promise<{ ok: boolean; reason?: string }>;
  fetchImpl?: typeof fetch;
}

/**
 * Operator launcher: paste the job, see which CLIs are on PATH, Start.
 * Desktop apps stay attached; only listed binaries can be spawned.
 */
export function ComposeForm({ onStart, fetchImpl = fetch }: ComposeFormProps) {
  const [job, setJob] = useState('');
  const [harnesses, setHarnesses] = useState<HarnessProbe[]>([]);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetchImpl('/harnesses')
      .then((response) => (response.ok ? response.json() : { harnesses: [] }))
      .then((body: unknown) => {
        const harnesses = (body as { harnesses?: HarnessProbe[] }).harnesses ?? [];
        if (!cancelled) setHarnesses(harnesses);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  return createElement(
    'form',
    {
      className: 'compose-form',
      'data-testid': 'compose-form',
      onSubmit: (event: { preventDefault(): void }) => {
        event.preventDefault();
        if (onStart === undefined || job.trim() === '') return;
        void onStart(job.trim()).then((result) => {
          setNotice(result.ok ? 'Job posted on #floor.' : result.reason);
        });
      },
    },
    createElement('label', { className: 'compose-label', htmlFor: 'compose-job' }, 'Job'),
    createElement('textarea', {
      id: 'compose-job',
      'data-testid': 'compose-job',
      className: 'compose-job',
      value: job,
      rows: 4,
      onChange: (event: { target: { value: string } }) => setJob(event.target.value),
    }),
    createElement(
      'ul',
      { className: 'compose-harnesses', 'data-testid': 'compose-harnesses' },
      harnesses.map((harness) =>
        createElement(
          'li',
          { key: harness.binary, 'data-available': harness.available ? 'true' : 'false' },
          `${harness.binary}${harness.available ? ' — available' : ' — attach only'}`,
        ),
      ),
    ),
    notice === undefined ? null : createElement('p', { role: 'status', 'data-testid': 'compose-notice' }, notice),
    createElement(
      'button',
      { type: 'submit', 'data-testid': 'compose-start', disabled: onStart === undefined || job.trim() === '' },
      'Start',
    ),
  );
}
