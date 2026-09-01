# Hub, interactive seats, and the verification gate

Written 31 Aug 2026, after bench vault-1.

## What the bench showed

Three agents cost 1.16× a solo agent's output tokens (1.41× all-in) and shipped
a game the operator judges "2 to 4 times better". The team's one irreplaceable
win was a peer testing code it did not own: population growth was silently
broken and the sim's author never found it.

The one clear weakness was **verification breadth**. `JOB.md` named a single
viewport and the team verified exactly that, three times over. Fan-out
multiplied effort inside the frame it was handed; it never widened the frame.

Two operator decisions follow from that, and they set this plan's scope:

1. Verification becomes structural, not something a brief has to remember to
   ask for: **every seat verifies its own work before it may say `done?`, and
   the integrating seat verifies again after assembly.**
2. Seats become **interactive sessions with Remote Control**, not `-p`, so a
   run can be watched and steered from a phone.

## Findings that constrain the design

Established by experiment before writing any code:

- **`--remote-control` needs a TTY.** Launched from a plain background process
  it prints `Input must be provided either through stdin or as a prompt
  argument when using --print` and exits — Claude Code falls back to print
  mode with no terminal. Under `script -q /dev/null claude …` it starts
  correctly and stays alive.
- **A fresh directory stops on the folder-trust dialog.** "Is this a project
  you created or one you trust?" is a blocking prompt, and a worktree created
  by `crosstalk init` is always fresh. Trust lives in `~/.claude.json` at
  `projects["<abs path>"].hasTrustDialogAccepted`. It must be pre-set per seat
  workspace or every interactive run stalls at launch — the exact failure the
  operator asked to eliminate.
- **`--permission-mode bypassPermissions`** is the mode that never prompts.
  `--allowedTools` is no longer sufficient once sessions are interactive.
- `~/.claude.json` per-project token totals only populate for interactive
  sessions that shut down gracefully. They were empty for the whole `-p` bench,
  which is why accounting reads the transcripts instead. Once seats are
  interactive this becomes a second, cheaper source for the hub.

## Track A — the session seam

`src/harness/session.ts` currently offers push (`stream-json` over stdin) and
pull (argv). Add a third: **`interactive`**, which spawns under a pty and
enables Remote Control.

    TurnFormat = 'stream-json' | 'argv' | 'interactive'

An interactive seat is driven by typing into the pty rather than by framing
JSON, so `send()` writes text plus a newline. `canPush` stays true: the board
can still deliver a turn mid-run, which is what makes a peer feel live.

`openSession` gains `remoteControlName` and, when interactive:

    script -q /dev/null claude --remote-control <seat> \
      --permission-mode bypassPermissions --model … --effort …

Trust is asserted before spawn, never after — a stalled seat cannot be rescued
by a later write.

## Track B — the shape carries verification

`src/core/shape.ts` gains two gates on `trio-contract`:

- `self-verified` — asserted per seat, quorum = all. A seat may not claim
  `done?` until it has posted evidence that its own surface passes.
- `integration-verified` — asserted once, by whoever merged, **after** assembly.

Both are `asserted` gates with a `ref`, so the phase machine already enforces
them; no new machinery. The point is that "verify your own work first" stops
being advice in a brief and becomes a gate the run cannot pass without.

Also closes the open gap: `crosstalk init --shape <id>`, so a shape survives
`--force` instead of being re-attached by hand.

## Track C — daemon routes for the launcher

- `GET /shapes` — the shape registry, for the picker.
- `POST /launch` — `{shape, seats:[{id,model,effort,harness}], prompt}`.
  Runs init if needed, writes trust and settings, spawns every seat, posts the
  prompt to `#floor` as `@human`, returns seat ids and Remote Control names.
- `GET /sessions` — per seat: alive, pid, Remote Control name, last presence
  verb and file, current phase.

## Track D — the hub

Full redesign against the existing 2.7k-line React app, which already has SSE
streaming, rooms and a composer. Two screens:

**Launcher.** Shape picker, a row per seat (model, effort, harness), prompt
box, start. This is the "type a prompt and they go" loop.

**Run.** Live board, a per-seat panel mirroring what each CLI is doing now
(presence verb, file, phase, gates outstanding), and the Remote Control name
so a phone can attach to any seat.

## Track E — Vault continues

Development continues on `moazessam376-dev/vault-bench-1` at `main`, with the
new gates and interactive seats. Known work from the operator's own play:

- elevator behaviour when a dweller is already in the car (real-time only —
  every judged run was `tick()`-accelerated, which skips the frame loop, so
  this was structurally invisible to the bench's verification)
- drag-and-drop dweller assignment
- raiders, radio recruitment, and the rest of the incident roster
- a first-run tutorial — nothing in the game teaches it
- a legible caps economy and win condition
- depth: the team's renderer is effectively 2D and should use the third axis
