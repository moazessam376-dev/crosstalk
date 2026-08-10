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
    // JUSTIFICATION WITHDRAWN — retained only because removing it needs
    // evidence too, and the daemon tests' owner has the call. See friction
    // entry 19.
    //
    // This was added believing the `fetch failed / Error: bad port` flake came
    // from concurrent daemons in parallel worker threads. It does not. The
    // cause is that `listen(0)` sometimes lands on a port the WHATWG fetch
    // spec blocks — 5060/5061 (SIP), 6000 (X11) — which `fetch` and every
    // browser refuse against a server that is bound and healthy.
    //
    // The experiment that motivated this setting was misread:
    //
    //   tests/daemon/server.test.ts alone ............. 6 runs, 6 green
    //   full suite .................................... 5 runs, 3 green
    //
    // That is not evidence about concurrency. One file starts far fewer
    // daemons than the whole suite, so it samples a ~1% event fewer times. A
    // rate is not a mechanism.
    //
    // Cost: the suite goes from ~6s to ~48s, for no measured benefit.
    fileParallelism: false,
  },
});
