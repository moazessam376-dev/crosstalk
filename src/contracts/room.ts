/** '#floor' | 'dm:codex~leader' | 'task:T-04' | 'dispute:C-118' */
export type RoomId = string;

export type RoomKind = 'floor' | 'dm' | 'task' | 'dispute';

/** The room every participant belongs to. */
export const FLOOR: RoomId = '#floor';

/** The human is a member of every room by construction. */
export const HUMAN_ID = '@human';
