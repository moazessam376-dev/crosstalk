import { defineConfig } from 'vitest/config';

// UI tests opt into jsdom per-file with `// @vitest-environment jsdom`,
// so Track B never has to edit this file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    reporters: 'default',

    // Test *files* run one at a time.
    //
    // Several daemon test files each start a real daemon on an ephemeral port.
    // Run in parallel worker threads they fail roughly two runs in five, always
    // as `TypeError: fetch failed / Caused by: Error: bad port` — the request
    // never leaves the client. Measured on this tree at 5a522ce:
    //
    //   tests/daemon/server.test.ts alone ............. 6 runs, 6 green
    //   tests/daemon, forks.singleFork=true ........... 3 runs, 3 green
    //   tests/daemon, default parallelism ............. 5 runs, 3 green
    //
    // So it is an artifact of concurrent daemons inside one test run, not a
    // defect in `startDaemon` — which is also why it does not threaten
    // `crosstalk up`, where exactly one daemon ever starts.
    //
    // This cost more than the two minutes it looks like. The flake was first
    // read as a lock-reclamation bug, a whole task was refused over it, and the
    // owning track was sent to fix a defect that was never there. A flaky test
    // is not a weaker failing test: it is a green signal that is sometimes
    // true, and it will supply evidence for whichever theory you bring to it.
    fileParallelism: false,
  },
});
