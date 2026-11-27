# HANDOFF — Cyberhell (legacy)

Handoff written 2026-11-26 ~8:30pm America/New_York for the new-account bot takeover (Joel via Alfred, 8:18pm ET). This branch adds documentation only. No game code was changed.

Cyberhell studio (game director) does not write game code. All code work was done by Dev Bot on its own pushed branches. Packets and reviews live on the old box under `/home/box/handoffs/` and may not carry over; open work is summarised below.

Joel 8:32am ET 2026-11-25: park legacy Cyberhell follow-ups unless prod breaks, and focus on the Sumi series (`jjcitron/sumi-cyberhell`). Do not start new legacy feature work without a new instruction.

## Live production

- URL: https://cyberhell.acidlemon.com
- Repo: `jjcitron/cyberhell`
- Production branch: **`master`** (not `main`)
- Prod SHA: `3220dda3f4d65a50fbf6426c1db3c029eb6d7961` (short `3220dda`) — PR #21, contain Oni Daimyo attack glow
- Prod deployment: `dpl_4bjpYNtExadZHGjFyyVcDPG3eRuL` (shipped 2026-11-25 8:26am ET by local fast-forward of `master`)
- Rollback SHA / deployment: `61a84625e6f70cacc2186384a02024440b36ce24` (PR #20) / `dpl_2Wda8zD9V26ZTjPELY62BopkVmsB`
- Stale `main` exists at `10a88e603ba135b30b82f837d81d900bf85305fd` and is **not** used for prod. Do not fast-forward or delete it without Joel's OK.

## Correction: `integration/approved` already exists

Earlier studio notes said this branch had not been created yet. That is wrong. As of this handoff:

- `origin/integration/approved` = `234236f2fc36f6a1e23ccdda19f36b435e8ec5ff` (short `234236f`)
- Message: "Merge PR #17 (ad4f342: gamepad fades touch) into integration/approved"
- It is **9 commits ahead of `master`, 0 behind** — a fast-forward from `3220dda` would move `master` to this tip. Do **not** do that.
- The integration tip already contains both open-PR branches below:
  - PR #17 `feat/gamepad-fades-touch` @ `ad4f342` (gamepad fades touch)
  - PR #7 `perf/hitch-quality-tiers` @ `0fbe202` (**DO NOT MERGE to prod** — playtest-only quality tiers)

This handoff branch was cut from `origin/master` (`3220dda`), not from `integration/approved`, per the handoff instruction.

## Ship flow (standing)

1. Independent verifier PASS, Codex visual gate, and GAD Art PASS (when the change is visual).
2. Ship request to Acidlemon Games with PR, SHA, preview link, what changed, and the rollback.
3. Acidlemon review, then QA Bot.
4. On Acidlemon's direct GO plus QA Bot PASS, Dev Bot ships by fast-forwarding **`master`** to a gated tip. No GitHub merge button, no force-push.
5. Joel gets the live URL. Every update to Joel carries a preview link. Do not paste share-link tokens into this file.

Standing integration rule (Joel 4:50pm ET, 2026-11-25): approved or gate-passed work merges into `integration/approved`; previews build from that tip; prod only moves by fast-forwarding `master`. Round 2+ stays on the same branch.

Git author AND committer must both be `Joel Citron <jcitron@aimediagroup.com>`. Check `git log -1 --format='%an <%ae> / %cn <%ce>'` before every push. Still needs Joel's exact OK: spending money, posting as Joel, store submissions, deletions, PR closes, changing other bots.

## In-progress work

SHAs and PR states were checked against GitHub at handoff time. Ahead/behind counts are vs `origin/master` @ `3220dda`.

| Item | Branch | SHA | PR | Status | Next step | Blocker |
|---|---|---|---|---|---|---|
| Hitch / quality tiers | `perf/hitch-quality-tiers` | `0fbe202` | [#7](https://github.com/jjcitron/cyberhell/pull/7) open (ahead 6, behind 4) | Title says **DO NOT MERGE yet** (playtest). Already merged into `integration/approved` @ `234236f` | Keep off `master` / prod until Joel explicitly OKs a playtest or a ship | Do not treat integration presence as a prod GO |
| Gamepad fades touch | `feat/gamepad-fades-touch` | `ad4f342` | [#17](https://github.com/jjcitron/cyberhell/pull/17) open (ahead 1, behind 4) | Already merged into `integration/approved` @ `234236f` | Needs the normal ship gate (verifier / Art if required / Acidlemon GO / QA) before any prod move | Parked-legacy posture unless someone unparks it; also already on the integration tip |
| MAP01 trooper pose and rifles | `codex/cyberhell-map01-trooper-fix-a-pose-and-a` | `374e18f` | [#18](https://github.com/jjcitron/cyberhell/pull/18) draft, open (ahead 1, behind 57) | Draft preview only. PR says tests 35/35, articulation 5/5, Codex visual gate pass. Do not merge or deploy | Rebase onto current `master` or `integration/approved` before any further work; 57 behind | Legacy / parked unless prod breaks; very stale base |
| Integration tip (not prod) | `integration/approved` | `234236f` | — | Exists; contains PR #7 + PR #17 | Do not fast-forward `master` to this tip | PR #7 is explicitly not for prod |
| Parked follow-ups (Codex queue) | various / none | — | — | Most `cyberhell.jsonl` items are marked `parked` | Leave parked unless prod breaks | Joel 8:32am park order. Includes: MAP01 boot loader race (Entryway vs Pack 1 MAP01), landscape-preferred toast on supported portrait, flinch/hit-react verification for Yurei #58 / Oni Daimyo #3003 / TRELLIS types, horn emissive hue at range, plate albedo under MAP01 lighting, Momo Oni (#3002) silhouette |

## Box packet / ledger paths (may not carry over)

- `/home/box/acidlemon/releases/cyberhell.md` — release ledger for current prod `3220dda` / `dpl_4bjpYNtExadZHGjFyyVcDPG3eRuL` and rollback `61a8462` / `dpl_2Wda8zD9V26ZTjPELY62BopkVmsB`.
- `/home/box/acidlemon/codex-queue/cyberhell.jsonl` (updated 2026-11-25 8:38am ET, then left parked). Open/parked items are listed in the table above. A later `/home/box/acidlemon/codex-queue/cyberhell-frontlines.jsonl` is the **Frontlines** queue, not this repo.
- `/home/box/handoffs/20261123-2235-cyberhell-gamepad-touch-fade/` — gamepad-fades-touch work that became PR #17.
- `/home/box/handoffs/20261125-0225-cyberhell-pr19-rebase-master/packet.md` — PR #19 pose fixes onto master (shipped via PR #20). Also notes the Oni Daimyo glowing-slab bug, which PR #21 (`3220dda`) shipped to fix.
- `/home/box/handoffs/20261125-0315-cyberhell-pr20-trellis-fix/` — Trellis / PR #20 follow-on.
- `/home/box/handoffs/20260908-1150-cyberhell-hitch-perf/` — earlier hitch/perf packet related to PR #7.

## Joel-held branches — do not touch

On **this** repo:

| Branch | SHA | Notes |
|---|---|---|
| `feat/sumi-levels-api` | `47b9a90` | Ahead 3, behind 4 vs `master`. Do not rewrite, force-push, or delete. |

These Joel-held names live on **`jjcitron/sumi-cyberhell`**, not on this repo (they are not present on `origin` here): `feat/cyberhell-final-1122`, `feat/cyberhell-editor`, `feat/gore-cyber-pinky`, `feat/era-rosters-oni-pinkie`, `fix/office-backdrop-music`.

## Local clones on the old box

Fresh handoff clone: `/workspace/cdev/handoff-cyberhell` (clean at write time). This documentation branch was cut from `origin/master`.

Other `/workspace/cdev` clones:

- `/workspace/cdev/cyberhell-pr21-ship` — clean, on `master`.
- `/workspace/cdev/cyberhell-master-baseline` and `/workspace/cdev/cyberhell-pr10-verify` — leftover worktrees pointing at `/workspace/cdev/cyberhell-pr10/.git/worktrees/...`, which is missing. Not usable as git checkouts. No attempt was made to commit anything from them.

No uncommitted work was found in the usable cdev clones of this repo.
