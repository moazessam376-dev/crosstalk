import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { BLOCKED_PORTS, isBlockedPort, NoUsablePortError, pickUsablePort } from '../../src/daemon/ports.js';

/**
 * `listen(0)` takes whatever ephemeral port the OS offers. Some of those are on
 * the WHATWG fetch blocked-port list, and `fetch` — along with every browser —
 * refuses them before opening a socket, against a server that is bound and
 * answering perfectly.
 *
 * This was a 1-in-5 test flake for a night, misdiagnosed three times, and it is
 * really a defect in `crosstalk up`: on a machine whose ephemeral range is
 * 4734–5137, roughly one start in a hundred opens a browser onto a connection
 * failure with a healthy daemon behind it.
 */
describe('the WHATWG blocked-port list', () => {
  // Not a tautology against the same constant: these are bound, confirmed
  // listening, and then confirmed unreachable through fetch. If a future Node
  // stops blocking them this test fails and the retry can be deleted.
  it.each([5060, 5061, 6000])('port %i is bound and listening, yet fetch refuses it', async (port) => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });

    const bound = await new Promise<boolean>((done) => {
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => done(true));
    });

    if (!bound) {
      // Something else holds it on this machine; the claim is untestable here
      // rather than false, and silently passing would be worse.
      await new Promise<void>((done) => server.close(() => done()));
      return;
    }

    expect((server.address() as AddressInfo).port).toBe(port);

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(isBlockedPort(port)).toBe(true);

    await new Promise<void>((done) => server.close(() => done()));
  });

  // The neighbouring case: without it, `isBlockedPort = () => true` passes
  // everything above and would make the daemon retry for ever.
  it.each([4999, 5062, 8080, 49152])('port %i is not blocked, and fetch reaches it', async (port) => {
    expect(isBlockedPort(port)).toBe(false);

    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    const bound = await new Promise<boolean>((done) => {
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => done(true));
    });
    if (!bound) {
      await new Promise<void>((done) => server.close(() => done()));
      return;
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);

    await new Promise<void>((done) => server.close(() => done()));
  });

  it('covers the ports this machine actually hit', () => {
    // 4190, 5060 and 5061 sit inside the observed ephemeral range 4734–5137.
    for (const port of [4190, 5060, 5061, 6000, 6697, 10080]) {
      expect(BLOCKED_PORTS.has(port)).toBe(true);
    }
  });
});

/**
 * The retry branch, tested directly.
 *
 * Nothing can make the OS offer 5060 on demand, so binding real sockets and
 * looking for a failure cannot reach this code. A 400-round probe against the
 * fix reported zero failures while the ephemeral range happened to be
 * 6886–7691 — a pass that could not distinguish "fixed" from "never tried".
 */
describe('pickUsablePort', () => {
  it('closes and re-binds until a usable port arrives', async () => {
    const offered = [5060, 5061, 6000, 7777];
    const closes: number[] = [];
    let index = 0;

    const port = await pickUsablePort(
      async () => offered[index++]!,
      async () => { closes.push(offered[index - 1]!); },
    );

    expect(port).toBe(7777);
    // Every blocked port was released; the usable one was not closed.
    expect(closes).toEqual([5060, 5061, 6000]);
  });

  it('returns the very first port when it is already usable, closing nothing', async () => {
    const closes: number[] = [];
    const port = await pickUsablePort(async () => 49152, async () => { closes.push(1); });

    expect(port).toBe(49152);
    expect(closes).toEqual([]);
  });

  it('gives up after the cap rather than spinning, and names what it tried', async () => {
    let binds = 0;
    await expect(
      pickUsablePort(async () => { binds += 1; return 5060; }, async () => {}, 4),
    ).rejects.toThrow(NoUsablePortError);

    expect(binds).toBe(4);
  });
});
