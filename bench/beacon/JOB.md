# Beacon

You are building Beacon, a short Three.js lighthouse game.

Work in this directory. Do not change the existing `createHarbor()` test that
already passes. Do not add Crosstalk-specific APIs.

## What to ship

- `src/types.ts` — `Ship`, `Beam`, and an illegal move table (you cannot
  refloat a wreck or undock a docked ship).
- `src/fleet.ts` — eight ships arrive over the night. Reject illegal moves
  with a named error.
- `src/beam.ts` — the lighthouse beam: a lit arc with a bearing. Ships
  steer for the dock only while their approach lane is lit; an unlit ship
  drifts toward the rocks.
- `src/harbor.ts` — the scene the player sees: dark water, the lighthouse,
  the dock, the rocks, the fleet, and the beam as a visible cone of light.

## Play

It is a light house game. The player aims the beam. Ships come in from the
open sea; a ship whose lane is lit makes for the dock, an unlit ship drifts
toward the rocks. Dock **8 ships**. A third wreck ends the run in failure;
the eighth docking ends it in success.

Graphics should look like a game, not a debug mesh dump: night water that
reads as water, a lighthouse that reads as a lighthouse, ships that read as
ships, and a beam that reads as light sweeping the water.

## Acceptance

- `npm run typecheck`, `npm test`, and `npm run build` pass.
- Opening the app shows the water, the lighthouse, the dock, and the fleet.
- The beam follows the player's pointer from the first frame.
- The title harbor is an attract shot where the beam sweeps on its own and
  input is ignored until the player presses Start.
- A docked/lost tally is on screen.
- The eighth docking ends the run.

## Mid-job note

The shared `Ship` type needs one more field so the sim and the renderer
agree on which approach lane a ship is using. Both import the type.

A cell that is green because `createHarbor()` does not throw, while the
page is an empty canvas, has not shipped.
