# Quorum

You are building Quorum, a tiny product for recording team decisions.

Work in this directory. Do not change the existing `render()` test that already
passes. Do not add Crosstalk-specific APIs.

## What to ship

- `packages/types` — a `Decision` type and an illegal-transition table.
- `packages/api` — an append-only log. Reject illegal transitions with a named
  error. Seed five decisions on boot.
- `packages/web` — a list of decisions and a header that shows counts.

## Acceptance

- `npm run typecheck`, `npm test`, and `npm run build` pass.
- Opening the app shows the seeded decisions.
- Hide resolved rows. The list must not show a decision once it is resolved.
- The header shows a resolved count.

## Mid-job note

The shared `Decision` type needs one more field so API and web can agree on
whether a row is hidden. Both packages import the type.

A cell that is green because `render()` does not throw, while the seed list is
not visible, has not shipped.
