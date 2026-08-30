# Cinder

You are building **Cinder**, a Three.js survival-defence game set on a waking
volcano.

Work in this directory. Everything is procedural — no external art, audio, or
model files. Three.js and the toolchain already in `package.json` are the only
runtime dependencies. Do not add Crosstalk-specific APIs.

## Premise

A research outpost sits on a volcanic island. The volcano wakes. Lava advances
downhill in flows you can divert but never stop. Creatures driven out of the
interior come for the outpost. You have one job: **evacuate twelve researchers
before the island is consumed.**

The island always loses. The question is how many people you get off it.

## What the player does

Place structures on the island to shape where the lava goes and to hold the
creatures off the landing pad, while researchers make their way from the outpost
to the pad and fly out in batches. Resources accumulate over time and from
deposits that the lava eventually buries — so early ground is worth more than
late ground, and everything you build is temporary.

**Win:** twelve researchers evacuated.
**Lose:** the outpost core is destroyed, or every remaining researcher is killed.

## The three systems

The work divides into three systems that share one contract and nothing else.
Whoever builds a system owns every file under its directory.

### `src/world/` — Island and atmosphere

The island as the player sees it. Procedural volcanic terrain from a seed, with
readable material zones (fresh basalt, old ash, scrub, black-sand beach, water).
Lava rendered as flowing emissive rock that lights the terrain around it and
shimmers with heat. Sky that moves from afternoon through dusk into an ash-lit
night as the eruption escalates. Ember particles, drifting ash, shoreline surf.

This system renders. It holds no game state and imports nothing from `src/sim/`.

### `src/sim/` — Eruption and life

The rules, as pure tickable code. Lava spreading cell by cell downhill across the
height grid, pooling in basins, cooling into new rock that changes where the next
flow goes, and diverting around player-built barriers. Creatures spawning at
vents, pathing toward the outpost around lava and obstacles, attacking what is in
their way. Structures with health and cost. Researchers moving from outpost to
pad. Resources. An eruption that escalates in stages.

This system imports no Three.js. It is a function of state, time, and commands.

### `src/game/` — Command and interface

Everything between the player and the rules. Camera with pan, orbit and bounds
that keep the island framed. A placement mode with a ghost preview that reads
valid or invalid before the click lands. Selection and an info panel. A HUD
carrying resources, researchers evacuated, eruption stage, and incoming threat.
Title attract, pause, and the two end cards. The frame loop that reads sim state
and hands the renderer what it needs.

## The contract

`src/contract.ts` is the only file all three systems import. Agree it **before**
any system work starts, and treat it as frozen once system work begins — if it
has to change after that, stop and say so rather than editing around it.

It carries, at minimum:

- `WorldGrid` — dimensions, cell size, heights, terrain kinds
- `LavaField` — per-cell heat and thickness
- `Structure`, `Creature`, `Researcher` — id, position, state
- `Command` — the union the interface sends the sim
- `GameState` — everything the renderer and HUD read
- The shared constants: grid size, evacuation target, eruption stage thresholds

Nothing else crosses system boundaries. If two systems need to agree on a number,
it belongs here.

## Core acceptance — this must ship, and it must be free of bugs

1. `npm run typecheck`, `npm test`, and `npm run build` pass.
2. Opening the app shows the island, the volcano, the outpost and the sea — not
   an empty canvas and not a debug mesh dump.
3. A title attract shot plays with input ignored until the player starts.
4. Lava visibly advances downhill over time and lights the ground around it.
5. Creatures spawn, path across the island, and reach the outpost.
6. The player can place at least one structure kind, with a preview that reads
   valid or invalid before the click.
7. The HUD shows resources, researchers evacuated, and eruption stage, and all
   three update from real state.
8. A run can be won and a run can be lost, and each ends with its own card.
9. A full run produces no uncaught exceptions.

### Judgeability hook — required

Expose `window.__cinder` with:

- `state()` — the current `GameState`
- `seed(n)` — start a deterministic run on seed `n`
- `command(c)` — issue a `Command` as the player would

The same seed must produce the same island and the same eruption. This is how the
run gets scored without a human driving it, so it is not optional.

## Depth — this is what separates a good submission from a shipped one

Core acceptance is the floor, not the target. Beyond it, more and better is
better, and this is where the game is actually judged:

- terrain that reads as a real volcanic island rather than coloured noise
- lava that cools into rock and reroutes the next flow through the shape it left
- more than one creature kind, with behaviour you can tell apart by watching
- structures that interact — a barrier that buys time for the thing behind it
- ash, embers, heat shimmer, light that changes as the eruption escalates
- pathing that visibly reacts to what the player builds
- progression across eruption stages that changes how the game is played
- camera feel, placement feel, hit feedback — the things that make it play well
- a losing run that is legible: you can see why you lost

## What "done" means

The game is done when a full winning run and a full losing run have both been
watched end to end in a browser, not inferred from a green test suite. Green
`typecheck`/`test`/`build` over an empty canvas is not a submission, and neither
is a game that has only ever been reasoned about.

Record honestly what you verified by eye and what you did not.
