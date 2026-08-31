# Leeward

You are building Leeward, a short Three.js fishing game.

Work in this directory. Do not change the existing `createScene()` test that
already passes. Do not add Crosstalk-specific APIs.

## What to ship

- `src/types.ts` — `Fish`, `Wind`, and an illegal catch table (you cannot
  catch a fish that is already landed).
- `src/school.ts` — ten fish in the water on boot. Reject illegal catches
  with a named error.
- `src/wind.ts` — a wind vector that pushes the boat. Gusts change heading.
- `src/scene.ts` — the scene the player sees: water, a boat, fish, wind.

## Play

It is a finishing game. The player steers a small boat on water. Wind
pushes the hull. Catch **10 fish**. When the tenth fish is landed, the
game is over.

Graphics should look like a game, not a debug mesh dump: water that reads
as water, a boat that reads as a boat, fish that read as fish, and a
visible wind condition (vane, wake, or water streaks).

## Acceptance

- `npm run typecheck`, `npm test`, and `npm run build` pass.
- Opening the app shows the water, the boat, and the school.
- The camera is locked on the boat from the first frame.
- The title harbor is a still wide shot with no boat until the player
  presses Start.
- A wind indicator is on screen.
- Landing the tenth fish ends the run.

## Mid-job note

The shared `Wind` type needs one more field so the sim and the renderer
agree on a gust. Both import the type.

A cell that is green because `createScene()` does not throw, while the
page is an empty canvas, has not shipped.
