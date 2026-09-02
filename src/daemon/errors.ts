/**
 * Transport failures, kept out of `ErrorCode` deliberately.
 *
 * `ProtocolError` is the protocol's own vocabulary — the ladder, the ledger and
 * the agent-facing error text all read it. A participant that cannot
 * authenticate has not made a claim about anything, so a 401 is not a protocol
 * event and does not become one. Contract §8.
 */
export type DaemonErrorCode =
  | 'MALFORMED_BODY'
  | 'MALFORMED_CONFIG'
  | 'UNAUTHENTICATED'
  | 'FROM_NOT_ALLOWED'
  | 'NOT_A_ROOM_MEMBER'
  | 'ROLE_NOT_PERMITTED'
  | 'UNKNOWN_ROUTE'
  /**
   * Asked to mirror a seat this daemon has no pipe to. Not a protocol failure:
   * a seat someone started in their own terminal is working perfectly and is
   * simply not watchable from here.
   */
  | 'NO_MIRRORED_SESSION'
  /** The seat's harness reads its prompt once and cannot be handed another. */
  | 'SESSION_CANNOT_TAKE_TURN'
  | 'DAEMON_ALREADY_RUNNING'
  | 'PORT_IN_USE'
  | 'PORT_BLOCKED'
  /** `--host` naming an address no interface on this machine has. */
  | 'HOST_UNAVAILABLE'
  /** Asked for a run this repository has never had, live or archived. */
  | 'UNKNOWN_RUN'
  /** Asked to archive the run currently being written to, or delete one still live. */
  | 'RUN_NOT_ARCHIVABLE'
  /** Delete without the run's own id typed back. The one irreversible act. */
  | 'RUN_NOT_CONFIRMED'
  /** Starting a run while seats from the last one still have live processes. */
  | 'RUN_IN_PROGRESS'
  | 'PAYLOAD_TOO_LARGE'
  /**
   * The transport was fine and the message was too long. Distinct from
   * PAYLOAD_TOO_LARGE, which is about bytes on the wire: this one an agent can
   * act on by compressing and moving the detail into `ref`.
   */
  | 'MESSAGE_TOO_LONG'
  // The message schema: a missing or over-budget tag, head or body, a required
  // `ref` or `to` absent, or a tag posted in the wrong kind of room. In-band
  // and separate from MALFORMED_BODY, because every one of these is something
  // the author can fix and re-send — the refusal text names the fix.
  | 'MESSAGE_REFUSED'
  | 'EVENT_KIND_NOT_APPENDABLE';

export class DaemonError extends Error {
  /** Set on DAEMON_ALREADY_RUNNING: the address of the daemon that holds the lock. */
  readonly url: string | undefined;

  constructor(
    readonly code: DaemonErrorCode,
    message: string,
    url?: string,
  ) {
    super(message);
    this.name = 'DaemonError';
    this.url = url;
  }
}
