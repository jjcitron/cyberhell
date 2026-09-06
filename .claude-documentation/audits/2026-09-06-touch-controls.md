# Touch controls rebuilt on the Delta Touch / Quad Touch model

Date: 2026-09-06
Branch: `touch/controls` (worktree `C:\Dev\Personal\_wt\ch-touch`)
Commits: `f6a193c`, `69ca8a9`

## The complaint

"The controls are no good, need a better way to look via touch without having to move
off the fire button." That was literally true of the old layout. Looking was a drag on
the canvas, tracked through a single `lookId` touch identifier; firing was a plain
`touchstart`/`touchend` button. The canvas listener and the button listener were
separate surfaces with separate single-finger state, so the aiming thumb had to leave
the trigger, and there was no way for one finger to do both.

## What changed

The whole layer is Pointer Events keyed by `pointerId` with `touch-action: none`, routed
by one handler on `#mobile-controls`. Each surface carries a `data-tc` role, and the
visible pads stack above the invisible input surfaces, so a finger that lands on a pad
can never also read as a bare look drag. Three fingers work at once because nothing
holds a single identifier any more.

**Look.** The entire right half of the screen (from 34% across, so the dead middle band
is included) is a look surface. Any touch there that moves turns yaw and pitch, and it
keeps turning while the same finger keeps sliding. There is no look-zone box.

**Fire pad that looks.** A large translucent crosshair pad sits under the right thumb in
the lower right. Touching it starts firing, and the same finger drags to turn the camera
without releasing. Firing continues through the drag. A small lock badge on the pad's
upper-left corner toggles autofire: with the lock on, a tap latches the trigger and the
next tap releases it.

**Move stick.** The left third spawns a floating analog stick under whichever thumb lands
there, with a 12px dead zone and a 60px full-tilt radius. Magnitude is analog: a small
tilt walks, a full tilt runs. At rest the stick is drawn faint at a home position so the
zone is discoverable rather than invisible.

**Everything else.** USE and JUMP as smaller pads beside the fire pad. Weapon prev/next
arrows on the right edge with the current weapon name between them, because the left
third belongs to the stick. Automap, pause and settings as icons along the top edge,
centred between the HUD readouts and the fullscreen button.

**HUD.** The six-slot weapon selector is hidden on touch. It wrapped to two rows and
owned the entire top-right corner, which is where the icon row and the fullscreen button
need to live. The edge arrows carry the weapon name instead. The three readouts
(bullets, health, armor) now cluster in the top-left corner rather than spreading across
the width.

**Purged.** `dpadKeys` and `runDpadSelfTest` are gone, replaced by `stickVector` and
`runStickSelfTest` (9 assertions, still driven by `?selftest=1`). The four-arm d-pad
markup, the `#m-btn-*` buttons and their `touchstart` handlers are deleted. The engine
methods those buttons called (`fireWeapon`, `interact`, `jump`, `switchWeapon`,
`toggleAutomap`, `pauseRun`) are untouched and are still what the new pads call.

## Layout, both target sizes

Screenshots taken from the headless run and reviewed:

- `.claude-documentation/audits/touch-851x393.png`
- `.claude-documentation/audits/touch-915x412.png`

| Control | Size | Placement |
|---|---|---|
| Fire pad | 116 x 116 | right 96, bottom 22 |
| USE | 70 x 70 | right 14, bottom 100 |
| JUMP | 70 x 70 | right 14, bottom 22 |
| Weapon prev / next | 52 x 52 | right 10, top 70 / top 150 |
| Top icons (map, pause, gear) | 48 x 48 | top 6, centred |
| Look surface | 34% to 100% wide, full height | right side |
| Move zone | 0 to 34% wide, below top 56 | left side |

Every action pad is at least 48 px. The container carries the four `env(safe-area-inset-*)`
values as padding, and because absolutely positioned children resolve against the padding
box, one declaration keeps the whole layer inside the notch and home bar. The fullscreen
corner button is unchanged.

Automated bounding-box checks at both viewports confirm: no control overlaps a HUD
readout, no two controls overlap each other, and nothing extends off screen.

## Settings

A gear icon opens a touch settings sheet that freezes the sim while it is up and resumes
on close. Everything is applied live and persisted to `localStorage` under
`cyberhell.touch`.

| Setting | Range | Default |
|---|---|---|
| Look sensitivity | 30 to 250 | 100 |
| Look dead zone | 0 to 14 px | 3 px |
| Control opacity | 15 to 100% | 55% |
| Invert Y | on/off | off |
| Autofire lock | on/off | off |
| Gyro assist | on/off | off |
| Left-handed | on/off | off |

Sensitivity 100 gives 0.0105 radians per pixel, which is 180 degrees for a 300 px sweep.
The measured value in QA is 100 degrees for a 200 px drag. Left-handed mirrors the look
surface, the move zone, the pad cluster, the arrows and the lock badge together.

The look dead zone is a start threshold, not a per-event filter. Filtering every small
delta would make a slow deliberate drag do nothing at all.

Gyro assist requests `DeviceOrientationEvent.requestPermission()` inside the tap that
enables it, which is what iOS requires, and falls back to a plain listener elsewhere. It
adds yaw and pitch from alpha and beta deltas at 0.6 assist, on top of the thumb, and is
off by default.

## Verification

All run headless in the isolated Chromium via `playwright-core` from
`C:/Dev/Tools/browserclaw-cli`, never the bcl daemon.

- `QA_PORT=8403 node tests/qa-mobile-start.js` - **ALL PASS**, 76 checks. The original
  four checks still pass. Multi-touch goes through CDP `Input.dispatchTouchEvent`,
  because Playwright's touchscreen API is single-tap only and the point of this layout
  is three fingers.
- `QA_PORT=8152 node tests/qa-collision.js` - **21/21**.
- `node --check` on the extracted inline script - clean.
- `runStickSelfTest()` extracted and run standalone - **9/9**.

What the new checks actually assert, at both 851x393 and 915x412: holding the fire pad
sets the trigger and drops a bullet; a 200 px drag with that same finger still down turns
the camera 100 degrees and the trigger stays held; lifting stops the fire; a bare drag in
the right half looks; a second finger on the left third spawns the stick, asks for
forward movement and walks the player 10+ units while the first finger keeps firing and
a drag keeps looking; lifting everything clears movement, fire and the stick; the arrows
change weapon and go back; the map icon opens the automap and tapping the map closes it;
the gear opens settings and freezes the sim, sliders apply live and persist, left-handed
moves the fire pad to the left, close resumes; and no page errors through any of it.

## Notes and what was left out

- **Crouch has no engine support.** There is no crouch state, height change or key
  binding anywhere in the engine, so there is no crouch icon. Adding one means a physics
  change, which is outside this task.
- **The autofire lock badge is 34 px, not 48.** It is an option toggle rather than an
  action, and at 48 px it would sit in the thumb's firing path on the pad. Flag it if it
  proves fiddly on a real device.
- **The automap now closes by tapping the map.** It renders at z-index 20, above the
  whole control layer, so the icon that opened it is buried while it is up. The modal's
  own caption was updated to say so.
- Desktop is untouched: mouse look still uses its own 0.0022 constant and pointer lock,
  and the desktop QA section passes unchanged.

## What Joel should feel for on device

1. Thumb never leaves the trigger. Hold the crosshair pad and swing 180 degrees without
   letting go, then check the shots kept coming through the whole swing.
2. Three fingers. Left thumb pushing the stick forward, right thumb on the trigger,
   index finger dragging in the right half. All three should be live at once.
3. Analog walk. A small stick tilt should creep, not sprint. If everything feels
   binary, the dead zone or radius needs tuning.
4. Sensitivity. Default is a 300 px sweep for 180 degrees. If that is slow on a real
   thumb, the slider goes to 250.
5. Landing accuracy. The USE and JUMP pads are 70 px next to a 116 px fire pad; check a
   thumb reaching for JUMP does not clip the trigger.
6. Left-handed and opacity, since neither can be judged from a screenshot.
