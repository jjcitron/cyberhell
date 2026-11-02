# Play events

Cyberhell posts anonymous events to same-origin `POST /api/event` (`api/event.js`, a Vercel function). The sink writes **one JSON line** per accepted event to the function log and returns 204. There is no database. The log is the store.

The beacon is JSON with content-type `text/plain` (what `sendBeacon` will queue). The sink also parses `application/json` and a missing `Content-Type`. An empty, missing, or unparseable body is a quiet 204: nothing is logged and nothing is printed with `console.error`. A body over 4096 bytes is 400. Unknown names are 400. `GET` and the other methods are 405 with `Allow: POST`. `OPTIONS` is 204.

## What fires

| name | when | type | props |
| --- | --- | --- | --- |
| `session_start` | once per page load | `session` | none |
| `level_start` | the run actually starts on a level, including the next level. A title-screen preload and a pause resume do not fire it. | `level` | `level`, `index`, `difficulty` |
| `death` | player health reaches 0 | `death` | those, plus `cause` (`hp`) |

`level` is a catalog id (`json1`, the boot map `map01`, or `custom` for an editor draft). A typed level title is never sent. `index` is the pack index. `difficulty` is the slider id (`story`, `easy`, `normal`, `hard`, `nightmare`, `custom`). Anything else in `props` is dropped. Strings are cut at 80 characters.

Every line also carries `client_id` (anonymous per-install id, `localStorage` key `cyberhell.cid`), `session_id`, `ts`, `game` (`cyberhell`), `host`, `env`, `build` (7-char git sha), `schema_v` (`1`), `internal`, and `internal_reasons`.

`internal` is true when any reason remains. The server recomputes reasons and unions them with the client's. A client `internal: false` cannot clear a server reason. Reason codes only: `vercel_app`, `preview_host`, `localhost`, `test_param`, `automation_ua`, `webdriver`, `opt_out`, `non_prod_env`, `qa_session`, `detect_error`. The user-agent string, IP, and email are never logged.

Nothing is sent for `?dev=1`, `?telemetry=0`, a `qa-runner` path, or an iframe. `?test=1` tags `test_param` and still sends. A blocked beacon or a 404 from a static host never throws into play.

## Read path

Vercel runtime logs, one JSON object per accepted event (same fields as Climb and Frontlines, `game` `cyberhell`):

```sh
vercel logs -p cyberhell ... -j
```

Retention follows the Vercel plan. For a durable copy, put a log drain on the project and read the same lines.
