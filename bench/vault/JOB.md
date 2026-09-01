# Vault

You are building **Vault**, a shelter-management game in Three.js — a desktop
web game in the mould of *Fallout Shelter*.

Work in this directory. Everything is procedural: no external art, audio, model
or texture files. Three.js and the toolchain already in `package.json` are the
only runtime dependencies. Do not add Crosstalk-specific APIs.

**This is a desktop game, not a mobile port.** Mouse and keyboard, a wide
viewport, hover states, right-click, drag, tooltips and keyboard shortcuts.
Do not build thumb-sized touch targets or a phone-shaped HUD.

## What it is

A cutaway view of an underground vault, dug into rock, seen side-on. Rooms are
wide horizontal bays arranged on a grid of floors, joined by elevator shafts.
Each room is a lit interior you can see into, full of small dweller figures
going about their work while the rock around the vault stays dark.

The player is the Overseer: build rooms, assign dwellers to the work they are
best at, keep power, food and water in balance, grow the population, and hold
the vault together when things go wrong.

### The look, in detail

You are matching a specific art direction, so here it is described rather than
referenced:

- **Cross-section.** The camera looks straight at a vertical slice of earth.
  Rooms are cut open like a doll's house. Between and around them is dark
  brown-black rock with visible strata and rubble.
- **Rooms as lit boxes.** Every room is its own warm pool of light spilling out
  into the rock, each type with a distinct colour grade — power rooms amber and
  industrial, water treatment cold blue-green, living quarters warm domestic,
  medbay clinical white-blue, diner red-and-cream. A room reads as *its type*
  from across the screen, before you read its label.
- **Elevators** are narrow vertical shafts in orange-amber, connecting floors,
  with a car that moves.
- **Dwellers** are small stylised figures in blue-and-yellow jumpsuits, idling,
  walking between rooms, riding elevators, and animating at their stations.
- **HUD.** A slim top bar: vault number and population, a happiness readout, and
  horizontal meters for power, food and water that fill and drain, plus caps.
  A build menu, a dweller roster, and a room detail panel. Retro-futuristic:
  green phosphor accents, chunky industrial frames, a slight scanline or CRT
  warmth is welcome. It should look designed, not like debug HTML.
- **Motion everywhere.** Lights flicker, meters ease rather than jump, dwellers
  never stand perfectly still, the elevator actually travels.

## The three systems

The work divides into three systems that share one contract and nothing else.
Whoever builds a system owns every file under its directory.

### `src/world/` — The vault, rendered

The cutaway itself. Procedural rock with strata and depth, room shells built
from the grid, per-type interior dressing (machinery, bunks, counters, terminals,
pipes), elevator shafts and moving cars, the light each room casts, dweller
figures and their animation, camera with pan and zoom over the whole vault, and
the visual states a room can be in — under construction, working, upgrading,
damaged, on fire, dark from a power cut.

This system renders. It holds no game state and imports nothing from `src/sim/`.

### `src/sim/` — The vault, as rules

Pure and tickable. Room production and consumption; the power/food/water economy
and what happens when one runs dry; dwellers with stats, happiness, health,
levels and a best-fit job; assignment and its effect on output; population growth
and new arrivals; build cost, placement legality, merging adjacent same-type
rooms, and upgrades; incidents — fires, vermin, raider attacks — that spread
between adjacent rooms and are fought by the dwellers standing there; rushing a
room for a bonus at the risk of an incident; caps, income and the passage of
time.

This system imports no Three.js. It is a function of state, time, and commands.

### `src/game/` — Everything between the player and the rules

Camera controls; the build menu and placement mode with a ghost preview that
reads legal or illegal before the click; selecting a room and its detail panel;
selecting and assigning dwellers, including drag-to-assign; the HUD meters and
caps; notifications and the incident alerts; tooltips; keyboard shortcuts; the
title screen; and the frame loop that steps the sim and hands the renderer what
it needs.

## The contract

`src/contract.ts` is the only file all three systems import. Agree it **before**
any system work starts, and treat it as frozen once system work begins — if it
has to change after that, stop and say so rather than editing around it.

It carries, at minimum: the vault grid and its coordinates; `RoomKind` and the
per-kind table of cost, size, capacity, production and the dweller stat it
favours; `Room`; `Dweller` with stats and state; `Resources`; `Incident`;
`Command` — the union the interface sends the sim; `GameState` — everything the
renderer and HUD read; and the shared constants.

Nothing else crosses system boundaries. If two systems need to agree on a
number, it belongs here.

## Core acceptance — this must ship, and it must be free of bugs

1. `npm run typecheck`, `npm test`, and `npm run build` pass.
2. Opening the app shows the vault in its rock, with rooms, dwellers and the
   HUD — not an empty canvas and not a debug mesh dump.
3. A title screen, with input ignored until the player starts.
4. The player can open the build menu, place a new room with a legal/illegal
   preview, pay for it, and watch it be built.
5. Dwellers can be assigned to a room and their assignment changes its output.
6. Power, food and water are produced, consumed, and shown on meters that move.
7. At least one incident can start, spread or be fought, and be resolved.
8. The population can grow.
9. The vault can fail, and failure is legible on screen.
10. A twenty-minute run produces no uncaught exceptions.

### Judgeability hook — required

Expose `window.__vault` with:

- `state()` — the current `GameState`
- `seed(n)` — start a deterministic run on seed `n`
- `command(c)` — issue a `Command` as the player would
- `tick(seconds)` — advance the simulation without waiting in real time

The same seed must produce the same vault. This is how the run gets scored
without a human driving it, so it is not optional. `tick` matters most: a judge
cannot sit through an hour of real time.

## Depth — this is where the game is actually judged

Core acceptance is the floor, not the target. More and better is better. Build
as much of this as you can:

- **Many room types**, each visually distinct and mechanically different:
  power generator, water treatment, diner, living quarters, medbay, science lab,
  storage, radio studio, workshop, training rooms for individual stats, and the
  overseer's office.
- **Room upgrades** and **merging** adjacent same-type rooms into a bigger,
  better-looking bay.
- **Dweller identity** — names, portraits or distinguishable figures, stats,
  levels, equipment, and a roster you can sort.
- **Best-fit assignment**: a dweller in the job matching their best stat
  visibly out-produces one who is not.
- **Happiness** that responds to conditions and feeds back into production.
- **Incidents with escalation**: fires that spread along a floor, vermin that
  breed, raiders that enter from the vault door and move room to room, each
  fought by whoever is standing there, with real consequences.
- **Rushing** a room for early output against a failure chance.
- **The wasteland**: send a dweller out, have things happen to them over time,
  bring them back with loot and a log of what they found.
- **Time of day**, ambient life, idle chatter, dwellers wandering to the diner.
- **Progression** that changes how the game is played as the vault grows.
- **Feel**: camera easing, meter animation, hover and selection states, click
  feedback, screen-shake on a raider hit, sound is out of scope but everything
  visual is not.

## How to verify — read this, it is not optional

**Never open a visible browser window, and never use a browser-automation
library.** No Playwright, no Puppeteer, no npm install for a browser driver.
Previous runs on this machine deadlocked on window focus and permission
prompts. Use the browser binary that is already installed, headless:

```bash
npm run build
npx vite preview --port 5300 --strictPort &
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --headless=new --disable-gpu --screenshot=/tmp/vault-shot.png \
  --window-size=1600,900 http://127.0.0.1:5300/
```

Then **read the PNG**. If the shot is blank, the page is blank, whatever the
tests say.

For a played run, drive the same binary over the DevTools protocol from plain
Node — `--headless=new --remote-debugging-port=<port>`, then talk to it with
`fetch` and a `WebSocket` — and use `window.__vault.tick()` to advance the
simulation quickly. Kill every headless process when you are done; never leave
one running.

## Working rules

- **Never ask the operator a question.** Nobody is reading. Make the call, write
  down what you assumed, and keep going. A run that stalls waiting for an answer
  has failed.
- **Never wait on a human for verification.** You have pixels; use them.
- Commit often. Small commits, on your own branch.

## What "done" means

Done is when the vault has been watched running in a browser — built up,
staffed, stressed and recovered — not inferred from a green test suite. Green
`typecheck`/`test`/`build` over an empty canvas is not a submission, and neither
is a game that has only ever been reasoned about.

Record honestly what you verified by eye and what you did not.
