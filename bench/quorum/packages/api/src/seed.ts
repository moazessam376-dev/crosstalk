import type { Decision } from '../../types/src/index.js';

/** Five decisions, at least one resolved, at least one open. */
export const SEED: Decision[] = [
  { id: 'D-1', title: 'Ship the daemon before the CLI', state: 'resolved' },
  { id: 'D-2', title: 'Keep the log append-only', state: 'open' },
  { id: 'D-3', title: 'Four tools on the agent surface', state: 'open' },
  { id: 'D-4', title: 'SPOC may not merge', state: 'resolved' },
  { id: 'D-5', title: 'Hide resolved rows in the list', state: 'open' },
];
