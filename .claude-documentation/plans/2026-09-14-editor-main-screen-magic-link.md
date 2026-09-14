# Editor on the main screen + magic link on the shared Acidlemon spine

**Job:** 20260914-0011-cyberhell-editor-magiclink (folds 20260903-0836-shared-auth-saves)
**Branch:** `feat/editor-main-screen-magic-link`, off `4e2abd3` (the PR5 editor-UX merge)
**Board OK:** Joel, 2026-09-14 00:11 ET — editor up on the main screen; magic link from
`Cyberhell@games.acidlemon.com`; he sets up the Mailgun subdomain and DNS in the AM; same
subdomain for every Acidlemon game.

## Goal

Put the editor on Cyberhell's title screen, and move Cyberhell's sign-in off its own private
login and onto the shared Acidlemon identity spine, sending from the studio subdomain.

## What was actually here

The job's hypothesis was that the 0836 extract already existed and only the Mailgun From address
and a main-screen link were missing. **That was half right, and the wrong half mattered.**

- The 0836 extract (`shared/acidlemon-id`, 26 new files) was written on the `box` host and
  delivered as `laptop-takeup.patch`. It was never taken up on this machine — there is no
  `acidlemon-games/shared/` directory here, and `id.acidlemon.com` still does not exist.
- Cyberhell already had a **complete, live, Cyberhell-only auth stack** — `api/auth/*` plus
  `api/_lib/{session,mail,store}.js` — lifted from Sumi in the same way 0836 lifted it. This is
  exactly the "second auth" the 0836 constraints were written to prevent, and it was already in
  production.
- So the fold is not "wire up the extract". It is "make the auth that already ships *be* the
  spine": same cookie, same id-hashing rule, same `users` + `user_apps` shape.

Deploying the 0836 service and pointing Cyberhell at it cross-origin was rejected for now:
`id.acidlemon.com` does not exist, standing it up is gated on human decisions in the 0836 blocker
list, and making a working editor depend on a service that is not there would trade a shipped
feature for an outage. The spine is a *schema and a secret*, not necessarily a extra network hop.

## Steps

1. **Main-screen entry.** `index.html`: a `LEVEL EDITOR` anchor next to `ENTER THE ABYSS`, amber
   so it reads as a different destination from the cyan CTA. A real `<a href>`, so it works
   before any script runs and middle-click behaves. Hidden by CSS in `mode-pause` / `mode-end`,
   because the same `#overlay-screen` element is reused for the pause and end-of-mission cards.
2. **Shared cookie.** `api/_lib/session.js`: cookie renamed `ch_session` → `al_session`, the old
   name still read so the change signs nobody out. `Domain=.acidlemon.com` — but only when the
   request host is actually an acidlemon.com host, because a `Domain` a browser does not own is
   dropped and that would break sign-in on every Vercel preview deployment. `clearCookie` names
   both cookies and both scopes, since a cookie with a `Domain` is a different cookie from one
   without and sign-out has to kill both.
3. **`user_apps`.** `db/schema.sql`: `user_apps(user_id, app, created_at)`, primary key on the
   pair. Deliberately not a `users.app` column — a player who edits Cyberhell packs and also
   plays Sumi is one user with two rows. Written on `/api/auth/verify`, and backfilled on
   `/api/auth/me` so an existing session joins the spine without signing out first. Both store
   backends (fs and blob+neon) implement it.
4. **Id-secret pin.** `emailHash` now keys on `ID_SECRET || SESSION_SECRET`. This closes 0836
   blocker #3: rotating an unpinned `SESSION_SECRET` re-hashes every user id and orphans every
   account and pack.
5. **Mailgun From.** `api/_lib/mail.js`: defaults to domain `games.acidlemon.com` and From
   `Cyberhell <Cyberhell@games.acidlemon.com>`, both env-overridable. The send path now gates on
   `MAILGUN_API_KEY` alone, so the only thing Joel has to paste is the one real secret.
6. **Save prompts sign-in.** `js/editor/app.js`: first save of a session opens the Account tab
   and names the sender. **The save still completes locally.** Prompting is not refusing, and
   losing a guest's level to a sign-in wall would be worse than no prompt at all.
7. **Docs.** `.claude-documentation/2026-09-14-mailgun-games-acidlemon-checklist.md`.

## Files

`index.html`, `css/editor.css`, `js/editor/app.js`, `js/editor/auth_ui.js`,
`api/_lib/{session,store,mail}.js`, `api/auth/{verify,me,logout}.js`, `db/schema.sql`,
`tests/api.test.mjs`, `tests/qa-editor-entry.js` (new), plus the two docs.

## Out of scope, deliberately

Hitch 1150 stays on `perf/hitch-quality-tiers` and is not touched. PR5's cursor/picker work is
not reopened. No Sumi file is edited — its cookie rename is a separate packet that signs its
players out once and needs Joel's say-so. No `shared/acidlemon-id` deploy.

## Verification

- `node --test tests/api.test.mjs` — 16/16, including the `al_session` name, the domain-scoping
  branch on both host shapes, `apps: ['cyberhell']` off `/api/auth/me`, and the Mailgun request
  asserted on the wire (capture server, no key, no network) to be `From:
  Cyberhell <Cyberhell@games.acidlemon.com>` at `/v3/games.acidlemon.com/messages`.
- `node tests/qa-editor-entry.js` — 8/8 in headless Chromium: the entry is visible and points at
  `editor.html`, it is hidden in pause mode, clicking it reaches `window.CyberEditor`, a
  signed-out guest's save completes, the Account tab opens naming the sender, and no page errors.

## Status: Completed

2026-09-14. Branch pushed; PR opened. Mail delivery itself is unverified and stays that way until
Joel's Mailgun domain verifies — that is the one acceptance item no code change here can close.
