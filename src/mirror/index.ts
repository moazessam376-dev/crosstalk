import { applyEvent, project } from '../core/projection.js';
import { GhTransport, type GitHubTransport } from './github.js';
import { MirrorQueue, type DrainResult } from './queue.js';
import { renderClaimComment } from './render.js';
import { commentRef, isPullable, pollInbound, postAsParticipant, renderInboundMessage } from './poll.js';

import type { HubState } from '../core/projection.js';
import type { CrosstalkEvent } from '../contracts/events.js';
import type { MirrorConfig } from '../contracts/config.js';

export interface StartMirrorOptions {
  repo: string;
  url: string;
  /** `@human`'s token. The inbound channel speaks as `@human` by holding it. */
  token: string;
  config: MirrorConfig;
  /** The branch pull requests are opened against. */
  base?: string;
  /** Test seam. Defaults to the `gh`-backed transport. */
  transport?: GitHubTransport;
  /** Test seam: overrides the `pollSeconds` cadence. */
  intervalMs?: number;
}

export interface MirrorHandle {
  stop(): Promise<void>;
  /** Drains without waiting for the timer. Used by tests and by `stop`. */
  drainNow(): Promise<DrainResult>;
  readonly state: HubState;
  readonly enabled: boolean;
}

/** A mirror that does nothing, for every degrade-to-nothing path. */
function inert(): MirrorHandle {
  return {
    stop: async () => {},
    drainNow: async () => ({ completed: 0, retrying: 0 }),
    state: project([]),
    enabled: false,
  };
}

/**
 * Starts the GitHub mirror.
 *
 * Called by `crosstalk up` once the daemon is listening, not from inside the
 * daemon: that is what keeps the mirror separately killable and makes "mirror
 * failure never blocks the protocol" structural rather than a discipline.
 *
 * It reads the log through `GET /stream?since=`, which is read-only and ordered
 * by `seq`, and has no path back into the append path — except the one the
 * inbound channel uses, which is `POST /events` holding `@human`'s token and so
 * carries exactly the authority `@human` has.
 *
 * Every reason not to run — mirror disabled, no `gh`, no credential — returns an
 * inert handle rather than throwing. A mirror that cannot start must cost the
 * caller nothing.
 */
export async function startMirror(options: StartMirrorOptions): Promise<MirrorHandle> {
  if (!options.config.github.enabled) return inert();

  const transport =
    options.transport ?? (await GhTransport.create(options.repo, options.base ?? 'main'));
  if (transport === undefined) return inert();

  // Aliased so the narrowing survives into the closures below, where a
  // `transport | undefined` would otherwise need a non-null assertion at every
  // use — and one of those assertions is how a real undefined gets through.
  const github: GitHubTransport = transport;

  const queue = new MirrorQueue(github);
  let state = project([]);

  // Replay from the beginning rather than persisting a cursor. The queue is
  // keyed by task and claim, so a whole log collapses to one job per entity
  // before the first drain, and reconciling is a no-op when GitHub already
  // matches. Statelessness costs one pass and buys restart-safety.
  const controller = new AbortController();
  const response = await fetch(new URL('/stream?since=0', options.url), {
    headers: { authorization: `Bearer ${options.token}` },
    signal: controller.signal,
  });

  if (!response.ok || response.body === null) {
    controller.abort();
    return inert();
  }

  const seen = new Set<number>();

  function absorb(event: CrosstalkEvent): void {
    state = applyEvent(state, event);

    // Remember what the mirror has already relayed inbound, so the poller can
    // be stateless: a comment whose ref is already on the floor is not resent.
    if (event.kind === 'message') {
      const match = /<!-- crosstalk:gh-comment:(\d+) -->/.exec(event.body ?? '');
      if (match?.[1] !== undefined) seen.add(Number(match[1]));
    }

    const task = state.tasks.get(taskIdOf(event));
    if (task !== undefined) queue.enqueue({ kind: 'task', task });
  }

  /**
   * Task id to pull request number, held in memory and never written down.
   *
   * The mirror cannot record the number on the task: that would mean appending
   * an event, and the mirror has no write path into the log. It does not need
   * to — the pull request is discoverable from the branch the task already
   * names, so this map is a cache of a lookup, rebuilt by replaying from
   * `since=0` on every start.
   */
  const pulls = new Map<string, number>();
  const rendered = new Map<string, string>();

  async function sync(): Promise<DrainResult> {
    const drained = await queue.drain();

    // Claims are enqueued here rather than on arrival because a claim's comment
    // needs its task's pull request, which may not have existed when the claim
    // event came through.
    for (const claim of state.claims.values()) {
      if (claim.taskId === undefined) continue;

      let pull = pulls.get(claim.taskId);
      if (pull === undefined) {
        const task = state.tasks.get(claim.taskId);
        if (task === undefined) continue;
        try {
          const found = await github.findPullRequestByBranch(task.branch);
          if (found === undefined) continue;
          pull = found.number;
          pulls.set(claim.taskId, pull);
        } catch {
          continue;
        }
      }

      // Only enqueue a claim whose rendered body has actually changed. Without
      // this the mirror would re-read every claim's comments on every tick to
      // discover it had nothing to say.
      // The decision that settled this claim, if one did. `claimId` is the
      // link the contract already provides; nothing needs to be inferred from
      // the dispute room name.
      const decision = [...state.decisions.values()].find(
        (candidate) => candidate.claimId === claim.id,
      );

      const body = renderClaimComment(claim, decision);
      if (rendered.get(claim.id) === body) continue;
      rendered.set(claim.id, body);
      queue.enqueue({
        kind: 'claim',
        claim,
        pullNumber: pull,
        ...(decision === undefined ? {} : { decision }),
      });
    }

    const second = await queue.drain();
    return {
      completed: drained.completed + second.completed,
      retrying: drained.retrying + second.retrying,
    };
  }

  const reader = response.body.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              absorb(JSON.parse(line.slice('data: '.length)) as CrosstalkEvent);
            } catch {
              // A frame the mirror cannot parse costs that frame, not the mirror.
            }
          }
        }
      }
    } catch {
      // Aborted on stop, or the daemon went away. Either way the mirror stops
      // reading and the protocol is untouched.
    }
  })();

  const everyMs = options.intervalMs ?? Math.max(1, options.config.github.pollSeconds) * 1000;

  const timer = setInterval(() => {
    void (async () => {
      await sync();
      await pollInboundOnce();
    })();
  }, everyMs);
  // A mirror must never be the reason the process stays alive.
  timer.unref?.();

  async function pollInboundOnce(): Promise<void> {
    try {
      await pollInbound({
        mode: options.config.github.mode,
        ...(options.config.github.humanLogin === undefined
          ? {}
          : { humanLogin: options.config.github.humanLogin }),
        comments: async () => {
          // The same discovered numbers the outbound half uses. Reading
          // `task.pr` here would poll nothing: the mirror cannot write it.
          const open = [...new Set(pulls.values())];
          const all = await Promise.all(open.map((pull) => github.listComments(pull)));
          return all.flat().map((comment) => ({
            id: comment.id,
            body: comment.body,
            authorAssociation: comment.authorAssociation ?? 'NONE',
            ...(comment.authorLogin === undefined ? {} : { authorLogin: comment.authorLogin }),
          }));
        },
        alreadyDelivered: (id) => seen.has(id),
        post: async (body) => {
          await postAsParticipant({
            url: options.url,
            token: options.token,
            room: '#floor',
            body,
          });
        },
      });
    } catch {
      // Same contract as the outbound queue: the inbound channel failing is a
      // missed comment, never a stalled protocol.
    }
  }

  return {
    enabled: true,
    get state() {
      return state;
    },
    drainNow: () => sync(),
    stop: async () => {
      clearInterval(timer);
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number';
}

function taskIdOf(event: CrosstalkEvent): string {
  const candidate = event as { task?: { id?: string }; taskId?: string };
  return candidate.task?.id ?? candidate.taskId ?? '';
}

function claimIdOf(event: CrosstalkEvent): string | undefined {
  const candidate = event as { claim?: { id?: string }; claimId?: string };
  return candidate.claim?.id ?? candidate.claimId;
}

export { renderInboundMessage, commentRef, isPullable };
