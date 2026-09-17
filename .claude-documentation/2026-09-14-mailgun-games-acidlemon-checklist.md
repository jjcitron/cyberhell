# games.acidlemon.com — Mailgun + DNS + env checklist

**For:** Joel, morning of 2026-09-14.
**Why:** Cyberhell's magic-link sign-in is wired and shipping; it sends from
`Cyberhell@games.acidlemon.com`. Until this domain verifies in Mailgun, the code falls back to
printing the link to the server log instead of emailing it. **Nothing in the UI is blocked on
this** — the editor, the main-screen entry and guest saving all work today. The only thing that
waits is an email actually arriving.

`games.acidlemon.com` is the studio sending subdomain for **every** Acidlemon title, not a
Cyberhell-only domain. Set it up once and Sumi, Space Runner and Clash reuse it with their own
From addresses on the same verified domain.

---

## 1. Mailgun

Add `games.acidlemon.com` as a **sending domain** (Sending → Domains → Add New Domain). Two
choices worth getting right up front:

- **Region.** Pick US or EU deliberately. The API base differs (`api.mailgun.net` vs
  `api.eu.mailgun.net`) and it cannot be changed later without re-verifying. If you pick EU, set
  `MAILGUN_API_BASE=https://api.eu.mailgun.net` in step 3 — the code already reads it.
- **Subdomain, not apex.** Keep `acidlemon.com` itself out of Mailgun. Sumi's existing sender
  lives on the apex; adding the games subdomain separately means a deliverability problem on one
  cannot take the other down.

Then confirm the domain is out of **sandbox / authorized-recipients** mode. This is the failure
that looks like success: in sandbox, mail to *your own* address arrives and mail to every real
player silently does not. Send a test to an address that is not on the authorized list before
calling it done.

## 2. DNS records

Mailgun prints the exact values on the domain's setup page — copy them from there, the ones
below are the shape, not the literals.

| Type | Host | Purpose | Required |
|---|---|---|---|
| TXT | `games.acidlemon.com` | SPF — `v=spf1 include:mailgun.org ~all` | yes |
| TXT | `<selector>._domainkey.games.acidlemon.com` | DKIM public key | yes |
| CNAME | `email.games.acidlemon.com` | click/open tracking | optional |
| MX | `games.acidlemon.com` | `mxa.mailgun.org` / `mxb.mailgun.org` | only if you want to *receive* |

Two things that catch people out:

- **Do not add a second SPF TXT record.** If `games.acidlemon.com` ends up with two `v=spf1`
  records, SPF hard-fails and everything lands in spam. One record, `include:mailgun.org` merged
  into it.
- **The MX records are only for inbound.** Magic links are outbound-only, so skip MX unless you
  want replies to `Cyberhell@games.acidlemon.com` to go somewhere. Adding MX to a subdomain that
  has no mailbox just bounces replies.

A DMARC record on the apex (`_dmarc.acidlemon.com`) covers the subdomain by inheritance. If one
already exists for Sumi, verify its policy is not `p=reject` with a strict alignment that the new
subdomain fails; `p=none` while you watch the reports is the safe first move.

Propagation is usually minutes, occasionally hours. Mailgun's **Verify DNS Settings** button is
the gate — green there means the code below starts sending with no redeploy needed.

## 3. Vercel environment (Cyberhell project → Settings → Environment Variables)

| Key | Value | Notes |
|---|---|---|
| `MAILGUN_API_KEY` | *(Mailgun private API key)* | **The one real secret here.** Paste it into Vercel only — never into a repo, a job packet, a board, or a log. |
| `MAILGUN_DOMAIN` | `games.acidlemon.com` | Optional. This is already the built-in default; set it only to override. |
| `MAILGUN_FROM` | `Cyberhell <Cyberhell@games.acidlemon.com>` | Optional. Also already the default. Set it if you want a different display name. |
| `MAILGUN_API_BASE` | `https://api.eu.mailgun.net` | **Only if you chose the EU region** in step 1. Omit for US. |
| `APP_URL` | `https://cyberhell.acidlemon.com` | Already set. The magic link is built from it, so it must be the real host or links point at the wrong place. |
| `APP_ID` | `cyberhell` | Optional; already the default. This is the value written into `user_apps`. |

Only `MAILGUN_API_KEY` is actually required — everything else already has the right default
compiled in. That is deliberate: one secret to paste, and mail starts working.

### Shared-identity variables (the 0836 spine)

These are what make one account span every Acidlemon game rather than four separate logins.

| Key | Value | Notes |
|---|---|---|
| `SESSION_SECRET` | *(the same value in every Acidlemon project)* | Already set on Cyberhell. Sumi has its own, different one today. Until they match, a session cookie minted by one title is not readable by the other. Making them match is a human step and it signs out whichever title gets the new value. |
| `ID_SECRET` | *(pin to the CURRENT `SESSION_SECRET` value)* | **Do this before ever rotating `SESSION_SECRET`.** User ids are an HMAC under this key. Rotating an unpinned `SESSION_SECRET` re-hashes every id and orphans every existing account and the packs attached to it. Setting `ID_SECRET` now costs nothing and makes rotation safe forever. |
| `COOKIE_DOMAIN` | *(leave unset)* | The code derives `.acidlemon.com` from the request host automatically, and deliberately does **not** scope the cookie on `*.vercel.app` preview deployments — scoping there would break preview sign-in. Set it only to force a value; `none` disables scoping. |

## 4. Still open from job 20260903-0836

Two items from the shared-auth job remain human decisions and are **not** blockers for Cyberhell
shipping today:

- **`id.acidlemon.com` does not exist.** The 0836 extract was written as a standalone service to
  be deployed there and consumed cross-origin. Cyberhell does not depend on it: it implements the
  same spine in-process, against the same cookie name, the same id-hashing rule and the same
  `users` + `user_apps` shape. When `id.acidlemon.com` does land, Cyberhell's `/api/auth/*`
  handlers become thin proxies — the cookies and the user ids already match, so there is no
  migration, just a redirect. Decide whether you want that extra hop at all; a shared *schema and
  secret* may be all the sharing that is actually needed.
- **Cookie name must agree across titles.** Cyberhell now sets `al_session` (and still reads the
  old `ch_session`, so nobody gets logged out by this change). Sumi sets `sumi_session`. Whichever
  name wins, it is a one-line constant in each title — but until Sumi changes, a Sumi sign-in
  does not carry into Cyberhell. That cutover needs your say-so because it signs Sumi's players
  out once.

## 5. How to tell it worked

1. Open <https://cyberhell.acidlemon.com/> — **LEVEL EDITOR** is on the title screen next to
   ENTER THE ABYSS.
2. Click it, build something, hit Save. The Account tab opens asking for an email.
3. Enter a real address that is **not** your own and not on any Mailgun authorized list.
4. The mail arrives from `Cyberhell@games.acidlemon.com`. Open the link, land back in the editor.
5. The Account tab reads **"Acidlemon account — cyberhell"**. That line is the `user_apps` row;
   when a second title joins the spine it will list both.

If step 4 does not arrive: check Mailgun's **Logs** tab first. A 401 there means the API key; a
"domain not verified" means step 2 is still propagating; a delivery to your own address but not
to others means the domain is still in sandbox.
