# QA still/background branch integration

Merge baseline: `chore/qa-still-bg` at `bafe3a0ff3726cd08ee5b47026b5e6f0f331d331`,
master at `26d02a88f73359b065968352dfc1ad86150b20de` (PR #10 included).

## Conflict choices

- `index.html`: retain the branch's measured enemy footprint, large-rig fitting,
  hurt volumes, wall/riser animation correction and corpse clearance. Keep master's
  automatically merged input-mode, touch CSS, gamepad and splash integration.
  Damage paths use `CyberDifficulty` once; god mode still blocks player damage
  independently and starts unchecked.
- `js/cyber-enemies.js`: use the branch's unconditional inner body wrapper, which
  implements both sides' same facing/bobbing correction once (180 degrees, never
  twice). Keep automatically merged master model/head/refinement backports and
  branch articulation, scale and animation changes.
- `tests/qa-collision.js`: retain the branch's richer shared vertex checks and
  corpse/riser/pose sweeps instead of master's duplicate inline vertex loop.
  Retain nonconflicting master changes. No assertions or tolerances were relaxed.
- `package.json`: retain cleanup scripts and Node engine requirement, add master's
  gamepad script, and include master plus integration unit tests in `npm test`.

## One difficulty implementation

`js/cyber-difficulty.js` owns selection, persistence, AI preset and damage factors.
Master's five-step slider retains its exact NORMAL default, live AI presets and
damage factors. The branch's two damage sliders and four legacy preset buttons
write a CUSTOM selection in that same module, with normal AI and the branch's
original damage factors. Enemy counts never depend on difficulty. Both menus
subscribe to the same state. Legacy `cyberhell.difficulty` saves migrate when no
master preset exists; CUSTOM selections persist using that JSON plus the existing
master selection key. Switching back to the master slider clears the override.
God mode is independent. Damage is never multiplied by both implementations.

## Integration regressions caught by QA

- CH-AI-3 found the branch's perpendicular wall push trapping a rusher at the
  convex endpoint in the L-shaped corridor. Endpoint caps now push radially;
  interior-wall push and the wall-crossing veto remain. Permanent unit coverage
  checks both segment orientations, rounding clearance and an interior crossing.
- CH-COL-14a found the backported Chaingunner clipping a riser by 0.052 with a
  0.05 limit. Keep the existing exhaustive sweep and give the drawn-body correction
  1 cm of extra clearance for between-frame animation. Gameplay collision radii
  and test tolerances are unchanged.
- Difficulty state tests cover preset/custom transitions, persistence, legacy
  migration, notification and malformed/out-of-range damage values.
- The two difficulty panels share a wrapping row so the desktop START button
  stays within a 1280x800 viewport. Tablet QA waits for the input-blocking splash
  before tapping START; its previous engine-ready check raced the splash gate.

## Cleanup reference audit

Search `index.html`, `editor.html` and `js/` for deleted `deus_vult.json`,
`MAP01.png`–`MAP05.png`, `build_dv_json.py` and `convert_pack1.py`: no hits.
Moved `convert_all_wads.py` and `patch_exit_switches.py` occur only in explanatory
comments; no runtime loader requests them. Pipeline entrypoints remain in `tools/`.

## Verification environment

Windows headless Chrome via explicit executablePath, local playwright-core and
puppeteer-core installs with `--no-save --package-lock=false`; no browser download.
Small external runner supplies browser paths and CommonJS harness loading without
changing harness assertions. Master and branch-tip baselines were measured in
detached worktrees before merge. Every suite uses separate loopback ports.
Desktop boot uses a Windows UA and maxTouchPoints=0, waits for splash blocking to
end, then verifies an actual START click, pointer lock, running level, gamepad and
all network responses. Detailed run logs, comparison table and preview status are
in the job packet's `candidate.json` and sibling `logs/` directory.
