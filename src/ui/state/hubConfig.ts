import type { ParticipantId } from '../../contracts/participant.js';
import type { RoomId } from '../../contracts/room.js';

/**
 * What the daemon tells the hub about itself — front-door interfaces §2.
 *
 * Served at `GET /config.json`, same-origin, authenticated by the cookie the
 * bootstrap redirect set. Same-origin is not a preference: `EventSource`
 * accepts no headers in any browser, so a cross-origin hub could not
 * authenticate its own stream at all.
 */
export interface HubConfig {
  version: number;
  self: ParticipantId;
  streamUrl: string;
  room: RoomId;
}

export type HubConnection =
  | { kind: 'loading' }
  /** A daemon answered. `live` is what the product is for. */
  | { kind: 'live'; config: HubConfig }
  /** No daemon — running from `vite dev` or a static build. The fixture keeps the hub useful. */
  | { kind: 'fixture'; reason: string };

const CONFIG_PATH = '/config.json';

function looksLikeConfig(value: unknown): value is HubConfig {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<HubConfig>;
  return typeof candidate.self === 'string'
    && typeof candidate.streamUrl === 'string'
    && typeof candidate.room === 'string';
}

/**
 * Resolves how this hub should get its events.
 *
 * Never throws: a hub that renders nothing because a fetch rejected is worse
 * than one that falls back and says so. The reason is carried through to the
 * UI rather than swallowed — "why am I looking at a fixture" is the first
 * question anyone will ask.
 */
export async function loadHubConfig(fetchImpl: typeof fetch = fetch): Promise<HubConnection> {
  let response: Response;
  try {
    response = await fetchImpl(CONFIG_PATH, { credentials: 'same-origin' });
  } catch (error) {
    return { kind: 'fixture', reason: `No daemon answered ${CONFIG_PATH} (${(error as Error).message}).` };
  }

  if (response.status === 401) {
    return {
      kind: 'fixture',
      reason: 'The daemon refused this browser. Open the hub from the link `crosstalk up` printed, so it can set your cookie.',
    };
  }

  if (!response.ok) {
    return { kind: 'fixture', reason: `${CONFIG_PATH} returned ${response.status}. Is this build being served by \`crosstalk up\`?` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'fixture', reason: `${CONFIG_PATH} was not JSON.` };
  }

  if (!looksLikeConfig(body)) {
    return { kind: 'fixture', reason: `${CONFIG_PATH} did not carry self, streamUrl and room.` };
  }

  return { kind: 'live', config: body };
}
