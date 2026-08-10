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
  | 'DAEMON_ALREADY_RUNNING'
  | 'PORT_IN_USE'
  | 'PAYLOAD_TOO_LARGE'
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
