# Action Preloader and Flash Messages

Last updated: 2026-10-22. This document describes the global action feedback UI added on top of the editor.

## Behavior

The app now has one fixed feedback region at the bottom center of the viewport (`bottom-6`, `w-[26rem]`; full-width and inset by `1rem` on small screens). It is rendered above all panels, stacks newest items closest to the bottom, and scrolls internally if more than 60vh of messages accumulate.

### Running actions

- While a request is in flight, a spinner card shows **Running <action>**.
- The same region shows every background Run with status `queued` or `running`.
- Duplicate labels are collapsed, so a two-model comparison shows one **Running model comparison** card, not two.
- Running cards are not dismissible; they disappear when the action or Run reaches a terminal state.

Action labels:

| Source | Label |
|---|---|
| Create project | `project creation` |
| Switch project | `project loading` |
| Import sample | `sample import` |
| Upload base image | `image upload` |
| Upload reference | `reference upload` |
| Submit edit | `scene edit` |
| Submit comparison | `model comparison` |
| Change padding / selection focus | `SAM selection` (while submitting) |
| Generate scene | `scene generation` |
| Open run history | `run history` |
| Open comparison history | `comparison history` |
| Retry a run | `retry` |
| Save evaluation | `evaluation save` |
| Select active version | `version switch` |
| Background generate Run | `scene generation` |
| Background segment Run | `SAM selection` |
| Background edit Run | `scene edit` |
| Background comparison edit Run | `model comparison` |

### Completed actions

- When a background Run moves from `queued`/`running` to `succeeded`, a green flash shows **<Action> completed.**
- The flash closes automatically after **3 seconds** or immediately via the **×** button.
- Immediate operations (project creation, sample import, upload, reference upload, evaluation save) show their own success message in the same green flash style.
- Queue acknowledgements are no longer separate notices; the running card covers that state and the completion flash follows.

### Errors

- Any failed action shows a red flash containing the error message.
- Run failures use the Run's `errorMessage`; an uncertain provider outcome (`needs_review`) is reported as **<Action> needs review.**
- Error flashes do **not** auto-close; they stay until the user clicks **×**.
- Identical still-visible messages are de-duplicated, so a repeated poll error does not stack copies. At most five flashes are kept.

## Implementation

- `src/components/ui/use-action-feed.ts` — flash queue, 3-second success timer, persistent errors, duplicate suppression, cleanup on unmount.
- `src/components/ui/ActionFeed.tsx` — fixed bottom-center presentation for running cards and flashes with `role="status"`/`role="alert"`, `aria-label="Dismiss notification"` and a CSS spinner.
- `src/lib/ui/action-feed.ts` — pure run label/transition logic:
  - `runActionLabel` maps Run kind and comparison grouping to a label.
  - `detectRunTransitions` reports runs that became terminal since the previous snapshot.
  - `runSuccessText`/`runFailureText` build the user-facing text.
- `src/components/AppShell.tsx` — owns the feed, marks each async handler with `beginBusy(label)`/`endBusy()`, derives background actions from the project snapshot, and reports Run transitions in an effect.
- Initial project load is suppressed: historical terminal Runs do not produce flashes. Switching projects resets the baseline; a Run that appears already terminal after the feed started is still reported (fast mock runs).

## Accessibility

- Running cards use `role="status"`; error flashes use `role="alert"`.
- The close control is a real `<button>` with an accessible label.
- Messages wrap (`break-words`) and the region is constrained to the viewport width on mobile.

## Verification

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — 35 files / 208 tests pass, including 8 new unit tests in `src/test/unit/action-feed.test.ts`
- `npm run build` — pass
- `npm run check:contracts` — pass
- Playwright mock suite — 16 tests pass, including:
  - a whole-scene edit that shows **Running scene edit** while the POST is delayed, then **Scene edit completed.** and verifies the 3-second auto-dismiss;
  - an error flash that remains visible after 3.5 seconds and disappears only after clicking **×**.

All verification used mock/fixture providers; no paid calls were made. See also [Selection and edit modes](selection-and-edit-modes.md).