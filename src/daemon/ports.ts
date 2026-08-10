/**
 * Ports that `fetch` and every browser refuse to connect to.
 *
 * From the WHATWG fetch standard's "bad port" list. A server can bind these
 * perfectly well; the *client* declines before opening a socket, so the failure
 * looks like a broken daemon rather than a blocked port:
 *
 *   TypeError: fetch failed
 *     Caused by: Error: bad port
 *
 * This matters because `listen(0)` takes whatever the OS offers. On the machine
 * this was found on the ephemeral range was 4734–5137, which contains 4190,
 * 5060 and 5061 — so about one `crosstalk up` in a hundred produced a hub the
 * browser would not load, with the daemon running and healthy behind it.
 *
 * It cost a night as a 1-in-5 test flake and was misdiagnosed three times
 * (lock reclamation, then test concurrency) before anyone read the port number.
 * See `docs/FRICTION-LOG.md` entry 19.
 */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

export function isBlockedPort(port: number): boolean {
  return BLOCKED_PORTS.has(port);
}

/**
 * How many ephemeral binds to try before giving up.
 *
 * The blocked set is tiny next to any ephemeral range, so a run of failures is
 * not a thing that happens — the cap exists so a pathological environment
 * cannot spin for ever.
 */
export const MAX_PORT_ATTEMPTS = 20;

export class NoUsablePortError extends Error {
  constructor(readonly attempts: number, readonly tried: readonly number[]) {
    super(
      `Could not obtain a usable ephemeral port in ${attempts} attempts; every one was on the blocked-port list (${tried.join(', ')}).`,
    );
    this.name = 'NoUsablePortError';
  }
}

/**
 * Binds repeatedly until the OS hands back a port a browser will connect to.
 *
 * Split out from `listen` and given its dependencies as parameters for one
 * reason: the retry branch is unreachable from a test that binds real sockets,
 * because nothing can make the OS offer port 5060 on demand. Verifying it by
 * starting daemons and hoping is how a 1% bug survives — a 400-round probe
 * against this very fix reported zero failures while the ephemeral range was
 * 6886–7691 and contained no blocked port, so it proved only that the
 * situation had not arisen.
 */
export async function pickUsablePort(
  bind: () => Promise<number>,
  close: () => Promise<void>,
  attempts: number = MAX_PORT_ATTEMPTS,
): Promise<number> {
  const tried: number[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await bind();
    if (!isBlockedPort(port)) return port;
    tried.push(port);
    await close();
  }

  throw new NoUsablePortError(attempts, tried);
}
